/** Keyless product smoke: actual dsh + Kleio launcher + persistent conversations. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDshSetup, prepareDshLaunch } from '../packages/harness-dsh/src/setup.ts';
import { DshEngine } from '../apps/server/dsh-engine.ts';
import { AgentStore } from '../packages/core/store.ts';
import { AgentService } from '../packages/core/service.ts';
import { acquireOwnership, type ServiceOwnership } from '../packages/core/ownership.ts';

const baseDir = fileURLToPath(new URL('../', import.meta.url));
const cli = resolve(baseDir, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const manifest = JSON.parse(await readFile(resolve(cli, '../../package.json'), 'utf8')) as { version: string };
assert.equal(manifest.version, '0.2.1-alpha.2', 'Install the pinned runtime before running this smoke');
const directory = resolve(baseDir, '.data/dsh-conversation-smoke', String(Date.now()));
const evidenceDirectory = resolve(baseDir, 'docs/kleio-v0.1-evidence');
const evidenceFile = join(evidenceDirectory, 'dsh-conversation-smoke.json');
await Promise.all([mkdir(directory, { recursive: true }), mkdir(evidenceDirectory, { recursive: true })]);

const firstPrompt = 'KLEIO-FIRST-TURN：本次测试暗号是青石；我喜欢简短中文。请用一句话确认。';
const firstAnswer = 'KLEIO-FIRST-ANSWER：已记住本次对话暗号青石，以及简短中文的偏好。';
const secondPrompt = 'KLEIO-SECOND-TURN：上一轮暗号和表达偏好是什么？只根据本次对话历史回答。';
const secondAnswer = 'KLEIO-SECOND-ANSWER：原生历史中的暗号是青石，表达偏好是简短中文。';
const thirdPrompt = 'KLEIO-THIRD-TURN：进程已经重启。请根据原生历史，确认前两轮提到的暗号和表达偏好。';
const thirdAnswer = 'KLEIO-THIRD-ANSWER：重启后的原生历史包含前两轮；暗号青石，偏好简短中文。';
const modelRequests: Array<{ phase: 'first' | 'second' | 'third' | 'auxiliary'; priorUserPresent: boolean; priorAnswerPresent: boolean; priorSecondAnswerPresent: boolean; presentToolMounted: boolean }> = [];
const evidence: Record<string, unknown> = {
  beganAt: new Date().toISOString(), runtime: `@deepseek-ai/dsh@${manifest.version}`,
  scope: 'prepareDshLaunch → DshEngine → AgentService → SQLite Conversation messages and markdown artifacts; two turns in one dsh process, then a third turn after a fresh process',
  model: 'scripted localhost OpenAI Chat Completions-compatible fixture',
  realPaidModel: false, externalAccountActions: false,
  restartMode: {
    shutdown: 'Orderly close only after both initial submissions completed and the Conversation had no active run.',
    reopen: 'Fresh ownership, AgentStore, AgentService and DshEngine against the same SQLite database, dsh home and workspace.',
    nativeCursorOrigin: 'The previous completed run sessionId, read normally from reopened SQLite by AgentStore.startRun; no manual setSession or cursor restoration in this probe.',
    continuationTrigger: 'A new explicit third user message; earlier prompts are not automatically resubmitted.',
    activeRunShutdownOrCrashRecoveryTested: false,
  },
  limitation: 'This validates product wiring and native history, not actual model quality, automatic memory extraction, file deliverables or desktop packaging.',
};

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('\n');
  if (value && typeof value === 'object' && 'text' in value) return text(value.text);
  return '';
}

let requestSequence = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.url?.endsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'kleio-smoke-model', object: 'model' }] }));
      return;
    }
    assert(request.url?.endsWith('/chat/completions'), 'Unexpected localhost model endpoint');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: unknown }>;
      tools?: Array<{ function: { name: string } }>;
    };
    const history = body.messages.map(message => text(message.content)).join('\n');
    // dsh can append environment/context messages after the actual user prompt.
    const latestUser = text(body.messages.findLast(message => message.role === 'user' && /KLEIO-(FIRST|SECOND|THIRD)-TURN/.test(text(message.content)))?.content);
    const phase = latestUser.includes('KLEIO-THIRD-TURN') ? 'third' : latestUser.includes('KLEIO-SECOND-TURN') ? 'second' : latestUser.includes('KLEIO-FIRST-TURN') ? 'first' : 'auxiliary';
    const priorAnswerPresent = history.includes(firstAnswer);
    const priorUserPresent = history.includes('KLEIO-FIRST-TURN');
    const priorSecondAnswerPresent = history.includes(secondAnswer);
    modelRequests.push({ phase, priorUserPresent, priorAnswerPresent, priorSecondAnswerPresent, presentToolMounted: body.tools?.some(tool => tool.function.name === 'present') ?? false });
    const answer = phase === 'third' ? (priorUserPresent && priorAnswerPresent && priorSecondAnswerPresent ? thirdAnswer : 'KLEIO-THIRD-ANSWER：重启后的原生历史缺失。') : phase === 'second' ? (priorUserPresent && priorAnswerPresent ? secondAnswer : 'KLEIO-SECOND-ANSWER：原生历史缺失。') : phase === 'first' ? firstAnswer : 'Kleio 受控测试';
    const id = `kleio-scripted-${++requestSequence}`;
    const frame = (delta: Record<string, unknown>, finishReason: string | null = null): string => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'kleio-smoke-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    response.setHeader('content-type', 'text/event-stream');
    response.write(frame({ role: 'assistant', content: '' }));
    response.write(frame({ content: answer }));
    response.write(frame({}, 'stop'));
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'kleio-smoke-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch {
    response.statusCode = 500;
    response.end('Controlled fixture request failed');
  }
});
await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('Local fixture did not bind');

const env: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PATHEXT', 'COMSPEC']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, {
  DSH_COMMAND: process.execPath, DSH_ARGS_JSON: JSON.stringify([cli]),
  DSH_HOME: join(directory, 'dsh-home'), DSH_WORKSPACE: join(directory, 'workspace'),
  KLEIO_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, KLEIO_MODEL_ID: 'kleio-smoke-model',
  KLEIO_MODEL_API_KEY: 'kleio-localhost-smoke-placeholder', TZ: 'Asia/Shanghai',
});
let store: AgentStore | undefined;
let service: AgentService | undefined;
let ownership: ServiceOwnership | undefined;
let ownershipLost = false;
async function open(): Promise<void> {
  ownership = await acquireOwnership(join(directory, 'product.sqlite'), () => { ownershipLost = true; });
  const launch = await prepareDshLaunch(env, { baseDir });
  store = new AgentStore(ownership.databasePath);
  service = new AgentService(store, new DshEngine({ ...launch, requestTimeoutMs: 30_000, promptTimeoutMs: 20_000, closeTimeoutMs: 3_000 }, launch.cwd));
}
async function closeProduct(): Promise<void> {
  await service?.close(); service = undefined;
  store?.close(); store = undefined;
  await ownership?.release(); ownership = undefined;
}

try {
  const setup = await inspectDshSetup(env, { baseDir });
  assert.equal(setup.status, 'ready'); evidence.configurationReadiness = setup;
  await open();
  const conversation = store!.createConversation('Kleio 真实 dsh 会话与重启受控验证');
  const first = service!.submitMessage(conversation.id, firstPrompt, 'controlled-first-turn');
  await service!.wait(first.runId);
  const firstRun = store!.run(first.runId);
  assert.equal(firstRun.status, 'completed', firstRun.error ?? 'The first run must complete');
  assert(firstRun.sessionId, 'The product must persist a native session cursor');
  const firstMessages = store!.messages(conversation.id);
  assert.equal(firstMessages.length, 2);
  assert.equal(firstMessages[1]?.content, firstAnswer);
  const firstArtifact = store!.artifacts().find(artifact => artifact.runId === first.runId);
  assert.equal(firstArtifact?.content, firstAnswer);
  evidence.firstTurn = { submission: first, run: firstRun, messages: firstMessages, artifact: firstArtifact };
  const second = service!.submitMessage(conversation.id, secondPrompt, 'controlled-second-turn');
  await service!.wait(second.runId);
  const secondRun = store!.run(second.runId);
  assert.equal(secondRun.status, 'completed', secondRun.error ?? 'The second run must complete');
  assert.equal(secondRun.sessionId, firstRun.sessionId, 'The resident dsh process must continue the prior native cursor');
  const messages = store!.messages(conversation.id);
  assert.equal(messages.length, 4);
  assert.equal(messages[3]?.status, 'completed');
  assert(messages[3]?.content.includes('原生历史中的暗号是青石'));
  const artifacts = store!.artifacts();
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts.find(artifact => artifact.runId === second.runId)?.content, messages[3]?.content);
  assert(modelRequests.some(request => request.phase === 'second' && request.priorUserPresent && request.priorAnswerPresent), 'The second model request must contain the native prior user and assistant history');
  assert(modelRequests.some(request => request.presentToolMounted), 'The Kleio profile must mount present for the actual model request');
  assert.equal(ownershipLost, false);
  evidence.secondTurn = { submission: second, run: secondRun, messages, artifacts, conversation: store!.conversation(conversation.id) };
  evidence.residentContinuationVerified = true;
  assert.equal(store!.conversation(conversation.id).activeRunId, null, 'Shutdown must happen after the Conversation becomes idle');
  const firstCloseAt = Date.now();
  await closeProduct();
  evidence.firstProductShutdown = { resolved: true, elapsedMs: Date.now() - firstCloseAt };

  await open();
  assert.equal(store!.messages(conversation.id)[1]?.content, firstAnswer, 'Product messages must survive database reopen');
  assert.equal(store!.messages(conversation.id)[3]?.content, secondAnswer);
  assert.equal(store!.run(store!.conversation(conversation.id).lastRunId!).sessionId, secondRun.sessionId, 'The cursor must originate from the normally reopened completed run');
  const third = service!.submitMessage(conversation.id, thirdPrompt, 'controlled-third-turn');
  await service!.wait(third.runId);
  const thirdRun = store!.run(third.runId);
  assert.equal(thirdRun.status, 'completed', thirdRun.error ?? 'The restarted run must complete');
  assert.equal(thirdRun.sessionId, firstRun.sessionId, 'The fresh dsh process must resume the persisted native cursor');
  const restoredMessages = store!.messages(conversation.id);
  assert.equal(restoredMessages.length, 6);
  assert.equal(restoredMessages[5]?.content, thirdAnswer);
  const restoredArtifacts = store!.artifacts();
  assert.equal(restoredArtifacts.length, 3);
  assert.equal(restoredArtifacts.find(artifact => artifact.runId === third.runId)?.content, thirdAnswer);
  assert(modelRequests.some(request => request.phase === 'third' && request.priorUserPresent && request.priorAnswerPresent && request.priorSecondAnswerPresent), 'The fresh-process model request must restore both earlier answers from native history');
  evidence.thirdTurnAfterRestart = { submission: third, run: thirdRun, messages: restoredMessages, artifacts: restoredArtifacts, conversation: store!.conversation(conversation.id) };
  evidence.nativeResumeVerified = true;
  evidence.productPersistenceVerified = true;
  evidence.presentToolMounted = true;
  evidence.status = 'completed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? { name: error.name, message: error.message } : { message: 'Unknown smoke failure' };
  process.exitCode = 1;
} finally {
  const closingAt = Date.now();
  try { await closeProduct(); evidence.finalProductShutdown = { resolved: true, elapsedMs: Date.now() - closingAt }; }
  catch { evidence.finalProductShutdown = { resolved: false }; evidence.status = 'failed'; process.exitCode = 1; }
  server.closeAllConnections();
  await new Promise<void>(closed => server.close(() => closed()));
  evidence.localModelServerClosed = true;
  evidence.modelRequests = modelRequests;
  evidence.endedAt = new Date().toISOString();
  const sources = ['scripts/smoke-dsh-conversation.ts', 'packages/harness-dsh/src/setup.ts', 'packages/harness-dsh/src/index.ts', 'apps/server/dsh-engine.ts', 'packages/core/service.ts', 'packages/core/store.ts', 'packages/core/contracts.ts'];
  evidence.sourceHashes = Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await readFile(resolve(baseDir, file))).digest('hex')])));
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: evidence.status, error: evidence.error, nativeResumeVerified: evidence.nativeResumeVerified, modelRequests: modelRequests.length, evidence: evidenceFile }));
}
