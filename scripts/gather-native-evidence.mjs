/** Summarize synthetic native-Harness acceptance sessions without exporting conversation content. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { zstdDecompressSync } from 'node:zlib';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sessionRoot = join(projectRoot, '.data', 'dsh-native', 'sessions');
const outputDirectory = join(projectRoot, 'docs', 'native-v0.2-evidence');
const outputFile = join(outputDirectory, 'session-summary.json');

// Export vocabulary, not arbitrary strings found in a session or an error.
const eventTypes = new Set([
  'permission/preset', 'sandbox/mode', 'approval/policy', 'approval/asked', 'approval/decided',
  'model/selection', 'agent/inbox/spliced', 'turn/start', 'turn/end', 'step/start', 'step/end',
  'system/message', 'developer/message', 'user/message', 'request/header', 'request/context',
  'session/title', 'session/title-llm-request', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result',
]);
const toolNames = new Set([
  'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'pwsh', 'bash', 'present',
  'web_search', 'web_fetch', 'clock', 'ask_user_question', 'enter_plan_mode', 'exit_plan_mode',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  ...['create_entities', 'create_relations', 'add_observations', 'delete_entities', 'delete_observations',
    'delete_relations', 'read_graph', 'search_nodes', 'open_nodes'].map(name => 'mcp__reference_memory__' + name),
]);
const models = new Set(['deepseek-flash', 'deepseek-pro']);
const providers = new Set(['deepseek-official', 'deepseek-account']);
const turnOutcomes = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']);
const approvalOutcomes = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
const policies = new Set(['ask', 'never']);
const permissionPresets = new Set(['default', 'read-only', 'workspace-write', 'danger-full-access', 'auto', 'custom']);
const safeTool = name => toolNames.has(name) ? name : '[other-tool]';
const count = (record, key) => { record[key] = (record[key] ?? 0) + 1; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

async function listSessionFiles(directory) {
  let rows;
  try { rows = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw new Error('Session directory cannot be read.'); }
  const files = [];
  for (const row of rows) {
    const path = join(directory, row.name);
    // Do not follow symlinks to directories or files outside the authorized session tree.
    if (row.isDirectory()) files.push(...await listSessionFiles(path));
    else if (row.isFile() && row.name === 'session.v4.jsonl.zstd') files.push(path);
  }
  return files.sort();
}

function decodeFrames(bytes) {
  const chunks = []; let offset = 0; let expanded = 0;
  while (offset < bytes.length) {
    // The supported one-shot API decodes one frame. bytesWritten reports its consumed input.
    const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true, maxOutputLength: 16 * 1024 * 1024 });
    const consumed = decoded.engine.bytesWritten;
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || offset + consumed > bytes.length) throw new Error('Invalid compressed session frame.');
    offset += consumed; expanded += decoded.buffer.length;
    if (expanded > 64 * 1024 * 1024) throw new Error('Session snapshot exceeds the evidence reader limit.');
    chunks.push(decoded.buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.endsWith('\n')) throw new Error('Session snapshot ends with an incomplete JSONL record.');
  return { frameCount: chunks.length, entries: text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) };
}

async function readSnapshot(file) {
  // The live backend can append a frame while we read. Retry a changing or incomplete snapshot.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = await stat(file); const bytes = await readFile(file); const decoded = decodeFrames(bytes); const after = await stat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('Session changed while reading.');
      return { ...decoded, bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
    } catch {
      if (attempt === 2) return null;
      await delay(50);
    }
  }
  return null;
}

function isAcceptanceSession(entries) {
  return entries.some(entry => entry?.type === 'user/message' && Array.isArray(entry.data?.content) &&
    entry.data.content.some(block => block?.type === 'text' && typeof block.text === 'string' && /验收(?:小林)?/u.test(block.text)));
}

function failureCategory(error, approvalOutcome) {
  // A rejected approval can yield an isError result without a separate error identity.
  // Correlate the durable approval audit by callId instead of reading its result text.
  if (approvalOutcome === 'rejected') return 'approval-rejected';
  if (approvalOutcome === 'cancelled') return 'cancelled';
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (code.includes('OUTCOME_UNKNOWN')) return 'outcome-unknown';
  if (/ABORT|CANCEL/.test(code)) return 'cancelled';
  if (/PERMISSION|DENIED|REJECT/.test(code)) return 'permission-denied';
  return 'other-failure';
}

function summarize(snapshot) {
  const header = snapshot.entries.find(entry => entry?.type === 'session') ?? {};
  const summary = {
    // The hash correlates repeated evidence snapshots without publishing native IDs or workspace paths.
    sessionRef: createHash('sha256').update(typeof header.id === 'string' ? header.id : snapshot.digest).digest('hex').slice(0, 16),
    formatVersion: Number.isSafeInteger(header.version) ? header.version : null,
    compressedSnapshot: { bytes: snapshot.bytes, frameCount: snapshot.frameCount, sha256: snapshot.digest },
    eventTypes: {}, models: [], providers: [],
    turns: { started: 0, outcomes: {}, openAtSnapshot: 0 },
    tools: {},
    approvals: { asked: 0, outcomes: {}, pendingAtSnapshot: 0, askedByTool: {}, policies: {}, permissionPresets: {} },
    userMessageCount: 0, assistantMessageCount: 0, assistantAttemptCount: 0,
  };
  const selectedModels = new Set(); const selectedProviders = new Set(); const calls = new Map();
  const approvalCalls = new Map(); const callApprovalOutcomes = new Map();
  const openTurns = new Set(); const asked = new Set(); const decided = new Set();
  const getTool = name => summary.tools[name] ??= { calls: 0, succeeded: 0, errorResults: 0,
    blockedOrCancelled: 0, unknownOutcome: 0, otherErrors: 0, pendingAtSnapshot: 0, errorCategories: {} };
  for (const entry of snapshot.entries) {
    if (!entry || entry.type === 'session') continue;
    const type = eventTypes.has(entry.type) ? entry.type : '[other-event]'; const data = object(entry.data);
    count(summary.eventTypes, type);
    if (type === 'model/selection' || type === 'request/context') {
      if (typeof data.model === 'string') selectedModels.add(models.has(data.model) ? data.model : '[other-model]');
      if (typeof data.provider === 'string') selectedProviders.add(providers.has(data.provider) ? data.provider : '[other-provider]');
    }
    if (type === 'user/message') summary.userMessageCount++;
    if (type === 'assistant/message') summary.assistantMessageCount++;
    if (type === 'assistant/attempt') summary.assistantAttemptCount++;
    if (type === 'turn/start') { summary.turns.started++; openTurns.add(data.turn); }
    if (type === 'turn/end') {
      const kind = object(data.reason).kind; count(summary.turns.outcomes, turnOutcomes.has(kind) ? kind : '[other-outcome]'); openTurns.delete(data.turn);
    }
    if (type === 'tool/call') {
      const name = safeTool(data.name); getTool(name).calls++; calls.set(data.callId, { name, settled: false });
    }
    if (type === 'tool/result') {
      const message = object(data.message); const call = calls.get(message.toolCallId); const tool = getTool(call?.name ?? '[other-tool]');
      if (call) call.settled = true;
      if (message.isError === true) {
        const category = failureCategory(object(data.error), callApprovalOutcomes.get(message.toolCallId)); tool.errorResults++; count(tool.errorCategories, category);
        if (category === 'permission-denied' || category === 'approval-rejected' || category === 'cancelled') tool.blockedOrCancelled++;
        else if (category === 'outcome-unknown') tool.unknownOutcome++;
        else tool.otherErrors++;
      }
      else tool.succeeded++;
    }
    if (type === 'approval/asked') {
      summary.approvals.asked++; asked.add(data.id); count(summary.approvals.askedByTool, safeTool(data.toolName));
      if (typeof data.callId === 'string') approvalCalls.set(data.id, data.callId);
    }
    if (type === 'approval/decided') {
      decided.add(data.id); count(summary.approvals.outcomes, approvalOutcomes.has(data.outcome) ? data.outcome : '[other-outcome]');
      const callId = approvalCalls.get(data.id);
      if (callId) callApprovalOutcomes.set(callId, data.outcome);
    }
    if (type === 'approval/policy') count(summary.approvals.policies, policies.has(data.policy) ? data.policy : '[other-policy]');
    if (type === 'permission/preset') count(summary.approvals.permissionPresets, permissionPresets.has(data.preset) ? data.preset : '[other-preset]');
  }
  summary.models = [...selectedModels].sort(); summary.providers = [...selectedProviders].sort();
  summary.turns.openAtSnapshot = openTurns.size;
  summary.approvals.pendingAtSnapshot = [...asked].filter(id => !decided.has(id)).length;
  for (const call of calls.values()) if (!call.settled) getTool(call.name).pendingAtSnapshot++;
  return summary;
}

const files = await listSessionFiles(sessionRoot); const sessions = []; let skippedNonAcceptance = 0; let unreadableSnapshots = 0;
for (const file of files) {
  const snapshot = await readSnapshot(file);
  if (!snapshot) { unreadableSnapshots++; continue; }
  if (!isAcceptanceSession(snapshot.entries)) { skippedNonAcceptance++; continue; }
  sessions.push(summarize(snapshot));
}
const aggregate = { sessions: sessions.length, turns: { started: 0, outcomes: {}, openAtSnapshot: 0 }, tools: {}, approvals: { asked: 0, outcomes: {}, pendingAtSnapshot: 0 } };
for (const session of sessions) {
  aggregate.turns.started += session.turns.started; aggregate.turns.openAtSnapshot += session.turns.openAtSnapshot;
  for (const [key, value] of Object.entries(session.turns.outcomes)) aggregate.turns.outcomes[key] = (aggregate.turns.outcomes[key] ?? 0) + value;
  aggregate.approvals.asked += session.approvals.asked; aggregate.approvals.pendingAtSnapshot += session.approvals.pendingAtSnapshot;
  for (const [key, value] of Object.entries(session.approvals.outcomes)) aggregate.approvals.outcomes[key] = (aggregate.approvals.outcomes[key] ?? 0) + value;
  for (const [name, tool] of Object.entries(session.tools)) {
    const total = aggregate.tools[name] ??= { calls: 0, succeeded: 0, errorResults: 0,
      blockedOrCancelled: 0, unknownOutcome: 0, otherErrors: 0, pendingAtSnapshot: 0, errorCategories: {} };
    for (const key of ['calls', 'succeeded', 'errorResults', 'blockedOrCancelled', 'unknownOutcome', 'otherErrors', 'pendingAtSnapshot']) total[key] += tool[key];
    for (const [key, value] of Object.entries(tool.errorCategories)) total.errorCategories[key] = (total.errorCategories[key] ?? 0) + value;
  }
}
aggregate.errorClassification = {
  expectedErrors: Object.values(aggregate.tools).reduce((total, tool) => total + tool.blockedOrCancelled, 0),
  unexpectedErrors: Object.values(aggregate.tools).reduce((total, tool) => total + tool.otherErrors + tool.unknownOutcome, 0),
  unknownOutcomes: Object.values(aggregate.tools).reduce((total, tool) => total + tool.unknownOutcome, 0),
  expectedErrorsDefinition: 'Native permission-denied, explicitly rejected approval, or cancelled tool results in the selected synthetic control tests.',
  unexpectedErrorsDefinition: 'Other tool error results or unknown external outcomes; user-aborted turns are recorded separately.',
};
const evidence = {
  generatedAt: new Date().toISOString(),
  source: '.data/dsh-native/sessions/**/session.v4.jsonl.zstd',
  selection: 'Only sessions containing a user text message with the synthetic acceptance marker 验收 (including 验收小林).',
  privacy: 'No prompts, assistant text, tool arguments/results, approval reasons, native IDs, workspace paths, credentials or tokens are exported.',
  status: unreadableSnapshots ? 'incomplete-snapshot' : sessions.length ? 'captured' : 'no-matching-sessions',
  scannedFiles: files.length, skippedNonAcceptance, unreadableSnapshots,
  aggregate, sessions,
  limitations: [
    'This is a persisted-log snapshot, not an assertion that every acceptance criterion passed.',
    'A completed turn is recorded separately from individual tool failures and approval rejections.',
    'Approval rejections, permission-denied tools and user-cancelled turns are control outcomes, not acceptance-test failures.',
    'Only allowlisted event, tool and model names are exported; other names are grouped.',
    'Run again after the agent becomes idle if a snapshot is incomplete or has pending work.',
  ],
};
await mkdir(outputDirectory, { recursive: true });
const temporary = `${outputFile}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(evidence, null, 2) + '\n');
await rename(temporary, outputFile);
// Console output intentionally contains counts only; source records are never printed.
console.log(JSON.stringify({ status: evidence.status, capturedSessions: sessions.length, unreadableSnapshots,
  completedTurns: aggregate.turns.outcomes.completed ?? 0, cancelledTurns: aggregate.turns.outcomes.aborted ?? 0,
  approvalRequests: aggregate.approvals.asked, toolCalls: Object.values(aggregate.tools).reduce((total, tool) => total + tool.calls, 0) }, null, 2));
