/** Read-only evidence collection after real browser acceptance; never dispatches a model call. */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(root, '.data/dsh-native');
const evidence = join(root, 'docs/personal-agent-v0.4-evidence');
const since = '2026-10-11T09:39:00.000Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function rows(file) {
  let bytes = readFileSync(file); const result = [];
  while (bytes.length) {
    const decoded = zstdDecompressSync(bytes, { info: true });
    if (!decoded.engine.bytesWritten) throw new Error('Session decoder made no progress.');
    result.push(...decoded.buffer.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
    bytes = bytes.subarray(decoded.engine.bytesWritten);
  }
  return result;
}
const sessions = new Map();
for (const workspace of readdirSync(join(home, 'sessions'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  for (const folder of readdirSync(join(home, 'sessions', workspace.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const path = join(home, 'sessions', workspace.name, folder.name, 'session.v4.jsonl.zstd');
    if (!existsSync(path)) continue;
    const entries = rows(path); const header = entries.find(entry => entry.type === 'session');
    if (!header || new Date(header.createdAt).toISOString() < since) continue;
    const events = entries.filter(entry => entry.type !== 'session');
    sessions.set(String(header.id), { header, events, sourceHash: hash(readFileSync(path)) });
  }
}
const app = new DatabaseSync(join(home, 'kleio/application.sqlite'), { readOnly: true });
const memory = new DatabaseSync(join(home, 'kleio/memory.sqlite'), { readOnly: true });
const records = (db, table) => db.prepare(`SELECT record FROM ${table}`).all().map(row => JSON.parse(row.record));
try {
  const tasks = records(app, 'personal_tasks'); const runs = records(app, 'personal_task_runs');
  const artifacts = records(app, 'personal_artifact_catalog');
  const memories = records(memory, 'personal_memories');
  const candidates = records(app, 'personal_memory_candidates');
  const profile = records(app, 'personal_profile')[0];
  const native = [...sessions].map(([id, { events, sourceHash }]) => ({
    sessionId: id, sourceHash,
    routes: events.filter(event => event.type === 'request/header').map(event => ({ provider: event.data.header.config.provider, model: event.data.header.config.model })),
    agentSteps: events.filter(event => event.type === 'step/start').length,
    titleRequests: events.filter(event => event.type === 'session/title-llm-request').length,
    turnEndReasons: events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
    tools: events.filter(event => event.type === 'tool/call').map(call => {
      const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId);
      return { name: call.data.name, callId: call.data.callId, hasResult: !!result, isError: result?.data.message.isError ?? null };
    }),
  }));
  const evidenceArtifacts = artifacts.map(artifact => ({
    id: artifact.id, taskId: artifact.taskId, sessionId: artifact.sessionId, bytes: artifact.bytes, sha256: artifact.sha256,
    currentFileMatches: existsSync(artifact.path) && hash(readFileSync(artifact.path)) === artifact.sha256,
    nativePresentationMatches: sessions.get(artifact.sessionId)?.events.some(event => event.type === 'deliverables/presented' && event.seq === artifact.source.eventSeq) || false,
  }));
  const finalized = tasks.filter(task => task.status === 'completed').map(task => {
    const run = runs.find(run => run.id === task.runId);
    return { id: task.id, sessionId: task.sessionId, attempt: task.attempt, status: task.status,
      finishReceipt: !!run?.finishReceipt,
      nativeCompleted: sessions.get(task.sessionId)?.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed') || false };
  });
  const sources = {};
  for (const path of ['config/assistant.md', 'packages/personal-agent/plugin.mjs', 'packages/personal-agent/source.mjs', 'packages/personal-agent/http.mjs', 'packages/personal-agent/artifacts.mjs', 'packages/personal-memory/controller.mjs', 'packages/personal-memory/capture.mjs', 'packages/personal-memory/candidates.mjs', 'packages/personal-memory/store.mjs', 'packages/personal-tasks/adapter.mjs', 'packages/personal-tasks/store.mjs', 'packages/personal-agent-ui/TasksPage.tsx', 'packages/personal-agent-ui/style.css', 'packages/personal-agent-ui/dist/client.js']) sources[path] = hash(readFileSync(join(root, path)));
  const report = {
    verifiedAt: new Date().toISOString(), scope: 'Read-only production data and native logs after real Flash/browser acceptance', since,
    nativeSessions: native, completedTasks: finalized,
    taskStates: tasks.map(task => ({ id: task.id, status: task.status, attempt: task.attempt, runs: runs.filter(run => run.taskId === task.id).map(run => ({ status: run.status, dispatched: run.dispatched })) })),
    artifacts: evidenceArtifacts,
    memories: memories.map(record => ({ id: record.id, version: record.version, deleted: record.deleted, source: record.source, reviewed: !!record.reviewActionId,
      revisions: memory.prepare('SELECT COUNT(*) AS count FROM personal_memory_revisions WHERE id=?').get(record.id).count })),
    candidates: candidates.map(candidate => ({ id: candidate.id, status: candidate.status, source: candidate.source, reviewActionId: candidate.reviewActionId || null })),
    profile: { version: profile.version, defaultAssistant: profile.assistant.name === 'Kleio', temporaryInstructionRemoved: profile.assistant.instructions === '', captureEnabled: profile.captureEnabled },
    sources,
    limitations: ['Agent steps and native title requests are event counts, not a measured transport-level paid request total.', 'The artifact hash checks integrity at this read; files remain editable originals.', 'No chat bodies, preference text, credentials, cookie or authentication URL are exported.'],
  };
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'live-runtime.json'), JSON.stringify(report, null, 2) + '\n');
  const key = process.env.KLEIO_MODEL_API_KEY;
  if (key) {
    const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (listed.status !== 0) throw new Error('Repository file enumeration failed.');
    let checked = 0; let matches = 0;
    for (const path of listed.stdout.split('\0').filter(Boolean)) {
      try { const bytes = readFileSync(join(root, path)); checked++; if (bytes.includes(Buffer.from(key))) matches++; } catch { /* A gitlink/directory has no file body. */ }
    }
    writeFileSync(join(evidence, 'credential-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checkedFiles: checked, configuredKeyOccurrencesInGitEligibleFiles: matches }, null, 2) + '\n');
    if (matches) throw new Error('Configured credential found in a Git-eligible file.');
  }
  console.log(JSON.stringify({ nativeSessions: native.length, completedTasks: finalized.length, verifiedArtifacts: evidenceArtifacts.filter(artifact => artifact.currentFileMatches && artifact.nativePresentationMatches).length, taskAttempts: runs.length, personalFacts: memories.filter(record => !record.deleted).length, reviewedCandidates: candidates.filter(candidate => candidate.status === 'accepted').length }, null, 2));
} finally { app.close(); memory.close(); }
