/** Opt-in paid auxiliary extraction check. Credentials are supplied externally, never loaded from files here. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryController } from '../packages/personal-memory/controller.mjs';
import { deepSeekMessagesBase } from './native-launch-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = join(root, 'docs/personal-agent-v0.4-evidence/memory-capture-provider.json');
const runtime = join(root, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai');
const load = (name, file = 'lib/index.js') => import(pathToFileURL(join(runtime, name, file)).href);
const originalCwd = process.cwd();
const credentialEnv = process.env.KLEIO_MODEL_API_KEY ? 'KLEIO_MODEL_API_KEY' : 'DEEPSEEK_API_KEY';
if (!process.env[credentialEnv]) throw new Error('Provide the configured provider credential through the launch environment. This script does not load credential files.');
if (process.argv.length > 2) throw new Error('This verification accepts no flags. It performs one paid extraction request.');
const endpoint = deepSeekMessagesBase(process.env.KLEIO_MODEL_BASE_URL || 'https://api.deepseek.com');
const route = { provider: 'deepseek-official', model: 'deepseek-flash' };
const temporary = await mkdtemp(join(tmpdir(), 'kleio-memory-capture-'));
const home = join(temporary, 'home');
const workspace = join(temporary, 'workspace');
const report = { verifiedAt: new Date().toISOString(), status: 'failed', dshVersion: '0.2.1-alpha.2', route,
  scope: 'Real auxiliary extraction through the published Harness LLM service. The native Session contains fixture-authored user and completed-turn events, not a live conversational model turn.',
  originalConversationModelRequests: 0, auxiliaryModelRequests: 0, candidateBodiesExported: false, checks: [], limitations: [
    'This check proves the extraction/review domain and provider route, not the conversational Agent-loop completion hook or browser UI.',
    'The extraction input is an isolated fixture, never imported into production memory.',
    'The request count is logical LLM dispatches; transport retries are governed by the provider. This fixture disables provider retries.',
  ] };
let launch, controller, dispose;
let errorCode;
try {
  const { runProfile } = await load('dsh', 'lib/profile-boot.js');
  const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment');
  const { createUserMessage } = await load('dsh-llm');
  const { SessionId } = await load('dsh-session');
  await mkdir(workspace, { recursive: true });
  process.env.DSH_HOME = home; process.env.DSH_TELEMETRY_MODE = 'DISABLED';
  process.env.GIT_CEILING_DIRECTORIES = [process.env.GIT_CEILING_DIRECTORIES, homedir()].filter(Boolean).join(delimiter);
  process.chdir(workspace);
  const patchPath = join(temporary, 'capture.patch.json');
  await writeFile(patchPath, JSON.stringify([
    { id: 'session-log-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
    { id: 'llm-deepseek', config: { apiKeyEnv: credentialEnv, baseURL: endpoint, reasoningEffort: 'low', retryPolicy: { mode: 'normal', maxRetries: 0 } } },
  ]));
  const values = { DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', [credentialEnv]: process.env[credentialEnv] };
  launch = await runProfile({ profile: 'web', patchFiles: [patchPath], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values }]) });
  const { ctx } = launch;
  const countingLlm = { async prepareCall(...args) {
    const call = await ctx.llm.prepareCall(...args);
    return { ...call, stream(options) { report.auxiliaryModelRequests++; return call.stream(options); } };
  } };
  controller = createMemoryController({ applicationPath: join(home, 'kleio/application.sqlite'), memoryPath: join(home, 'kleio/memory.sqlite'),
    llm: countingLlm, captureLimits: { dailyCalls: 1, queue: 1 } });
  controller.capture.start();
  // This is the same handler used by the production plugin; only the trigger events are fixture-authored.
  dispose = ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') controller.capture.enqueueCompletedTurn(session, event.data.turn);
  });
  const session = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd: workspace } });
  const user = createUserMessage({ content: [{ type: 'text', text: '我长期偏爱不加糖的桂花乌龙冷泡茶，这是稳定的饮品偏好。' }], source: { kind: 'user' } });
  session.append('request/header', { header: { config: route }, reason: 'initial' });
  session.append('turn/start', { turn: 1 });
  session.append('user/message', user, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await controller.capture.whenIdle();
  await ctx.sessions.flush(session);
  const stats = controller.capture.stats();
  assert.equal(stats.jobs.completed, 1, `Extraction did not complete: ${stats.latestJob?.errorCode || stats.latestJob?.skipReason || 'unknown'}`);
  assert.equal(report.auxiliaryModelRequests, 1);
  const candidates = controller.candidatesList();
  assert.ok(candidates.length > 0 && candidates.length <= 4, 'The provider did not propose an appropriately sourced memory.');
  const nativeEvents = session.snapshotEvents();
  const nativeUser = nativeEvents.find(event => event.type === 'user/message' && event.data.id === user.id);
  assert.ok(nativeUser);
  const candidate = candidates.find(candidate => candidate.sourceQuote.includes('桂花') || candidate.text.includes('桂花'));
  assert.ok(candidate, 'No proposed fact was supported by the supplied preference.');
  const expected = { sessionId: String(session.id), turnId: '1', messageId: String(user.id) };
  assert.deepEqual(candidate.source, expected);
  assert.ok(user.content[0].text.includes(candidate.sourceQuote));
  const before = controller.memory.search({ query: '桂花', limit: 8 });
  assert.equal(before.length, 0); assert.equal(controller.memoryList().length, 0);
  const accepted = controller.candidatesAccept({ id: candidate.id, expectedVersion: candidate.version, mode: 'create' });
  const after = controller.memory.search({ query: '桂花', limit: 8 });
  assert.equal(after.length, 1); assert.deepEqual(after[0].source, expected);
  assert.equal(accepted.memory.reviewActionId, accepted.candidate.reviewActionId);
  assert.equal(controller.db.prepare('SELECT kind FROM app_actions WHERE id=?').get(accepted.memory.reviewActionId)?.kind, 'candidate.accept');
  report.checks = [
    'Published Web profile and official DeepSeek API-key provider booted in a separate temporary Home.',
    'Exactly one logical auxiliary Flash request completed; no original conversational model request or memory-write tool was dispatched.',
    'Provider-produced proposals passed strict JSON and exact direct-user source-quote validation.',
    'Pending candidates did not enter formal memory or recall.',
    'Explicit review wrote one formal fact with original native source and a separate app review action.',
  ];
  report.nativeSource = expected;
  report.candidates = { proposed: candidates.length, selectedStatusBefore: candidate.status, selectedStatusAfter: accepted.candidate.status };
  report.formalRecall = { before: before.length, after: after.length, versions: controller.memoryHistory({ id: accepted.memory.id }).length };
  report.capture = { latestJob: stats.latestJob, jobs: stats.jobs, limits: stats.limits };
  report.status = 'passed';
} catch (error) {
  errorCode = typeof error?.code === 'string' && /^[A-Z_]{1,60}$/u.test(error.code) ? error.code : 'VERIFICATION_FAILED';
  report.errorCode = errorCode;
  if (controller) report.capture = controller.capture.stats();
} finally {
  dispose?.();
  await controller?.close();
  if (launch) await launch.shutdown.shutdown(report.status === 'passed' ? 0 : 1);
  process.chdir(originalCwd);
  // Keep one shell/runtime end-to-end and verify the absolute recursive cleanup target.
  const child = relative(resolve(tmpdir()), resolve(temporary));
  if (!child || child.startsWith('..') || isAbsolute(child) || !basename(temporary).startsWith('kleio-memory-capture-')) throw new Error('Unexpected temporary cleanup path.');
  await rm(temporary, { recursive: true, force: true });
  report.temporaryDataRemoved = true;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, route, auxiliaryModelRequests: report.auxiliaryModelRequests,
  candidates: report.candidates, formalRecall: report.formalRecall, temporaryDataRemoved: report.temporaryDataRemoved, ...(errorCode ? { errorCode } : {}) }, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
