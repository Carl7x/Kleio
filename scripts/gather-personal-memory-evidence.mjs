/** Read-only, content-free evidence for the synthetic K103 application-memory acceptance run. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sessionRoot = join(root, '.data/dsh-native/sessions');
const databasePath = join(root, '.data/dsh-native/kleio/memory.sqlite');
const outputFile = join(root, 'docs/personal-agent-v0.3-evidence/model-memory.json');
// This is an explicitly identified synthetic fixture, never an arbitrary user-record export.
const targetId = '3c29f398-80f8-4795-81f0-a0658f06ecc9';
const toolNames = new Set(['remember', 'recall', 'correct', 'forget', 'history', 'restore'].map(name => `personal_memory_${name}`));
const operationTools = { remember: 'personal_memory_remember', correct: 'personal_memory_correct', forget: 'personal_memory_forget', restore: 'personal_memory_restore' };
const modelNames = new Set(['deepseek-flash', 'deepseek-pro']);
const providerNames = new Set(['deepseek-official', 'deepseek-account']);
const turnOutcomes = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const ref = value => typeof value === 'string' && value.length ? hash(value).slice(0, 20) : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const texts = value => Array.isArray(value?.content) ? value.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
const increment = (record, key) => { record[key] = (record[key] ?? 0) + 1; };
const normalized = value => value.replaceAll('\r\n', '\n').trim();
const sameSource = (left, right) => left?.sessionId === right?.sessionId && String(left?.turnId) === String(right?.turnId) && left?.messageId === right?.messageId;
const number = value => Number.isSafeInteger(value) ? value : null;

async function filesBelow(directory) {
  let rows;
  try { rows = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw new Error('Session inventory unavailable.'); }
  const files = [];
  for (const row of rows) {
    const file = join(directory, row.name);
    // Deliberately do not follow symlinks outside this application's session tree.
    if (row.isDirectory()) files.push(...await filesBelow(file));
    else if (row.isFile() && row.name === 'session.v4.jsonl.zstd') files.push(file);
  }
  return files.sort();
}

function decode(bytes) {
  const chunks = []; let offset = 0; let expanded = 0;
  while (offset < bytes.length) {
    const frame = zstdDecompressSync(bytes.subarray(offset), { info: true, maxOutputLength: 16 * 1024 * 1024 });
    const consumed = frame.engine.bytesWritten;
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || offset + consumed > bytes.length) throw new Error('Invalid session frame.');
    offset += consumed; expanded += frame.buffer.length;
    if (expanded > 64 * 1024 * 1024) throw new Error('Evidence input exceeds its bound.');
    chunks.push(frame.buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.endsWith('\n')) throw new Error('Incomplete durable snapshot.');
  return { frameCount: chunks.length, entries: text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) };
}

async function snapshot(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = await stat(file);
      if (before.size > 64 * 1024 * 1024) throw new Error('Compressed input exceeds its bound.');
      const bytes = await readFile(file); const parsed = decode(bytes); const after = await stat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('Concurrent append.');
      return { ...parsed, byteCount: bytes.length, sha256: hash(bytes) };
    } catch { if (attempt < 2) await delay(50); }
  }
  return null;
}

function selected(entries) {
  const directUserText = entries.filter(event => event?.type === 'user/message' && event.data?.source?.kind === 'user').map(event => texts(event.data));
  return directUserText.some(text => text.includes('自有记忆验收')) && directUserText.some(text => /K103\b/u.test(text));
}

function parseJsonText(message) {
  try { return JSON.parse(texts(message)); } catch { return undefined; }
}

function recordsFrom(value) {
  if (Array.isArray(value)) return value.filter(row => row && typeof row === 'object' && row.id === targetId);
  return value?.id === targetId ? [value] : [];
}

function readFixtureDatabase() {
  // Do not import MemoryStore: its constructor initializes/migrates schema and would write.
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN');
    const row = db.prepare('SELECT record FROM personal_memories WHERE id=?').get(targetId);
    const revisions = db.prepare('SELECT version,operation,record,source FROM personal_memory_revisions WHERE id=? ORDER BY version').all(targetId)
      .map(item => ({ version: item.version, operation: item.operation, record: JSON.parse(item.record), source: JSON.parse(item.source) }));
    const indexRows = db.prepare('SELECT COUNT(*) AS count FROM personal_memory_search WHERE id=?').get(targetId).count;
    const activeRows = db.prepare('SELECT COUNT(*) AS count FROM personal_memories WHERE id=? AND deleted=0').get(targetId).count;
    db.exec('COMMIT');
    return { record: row ? JSON.parse(row.record) : undefined, revisions, indexRows: Number(indexRows), activeRows: Number(activeRows) };
  } finally { db.close(); }
}

function summarize(input, assistantInstructions) {
  const header = input.entries.find(event => event?.type === 'session') ?? {};
  const result = {
    sessionRef: ref(header.id), workspaceRef: ref(header.cwd),
    snapshot: { sha256: input.sha256, bytes: input.byteCount, frames: input.frameCount },
    nativeModels: {}, nativeProviders: {}, modelAssistantMessages: 0, nativeFlashAssistantMessages: 0,
    directUserMessages: 0, turnsStarted: 0, turnOutcomes: {}, openTurns: 0,
    behavior: { expectedBodySha256: hash(assistantInstructions), bodyMatches: 0, namedSectionInDurableSystemMetadata: false },
    memoryContext: { namedSnapshots: 0, snapshotsContainingTarget: 0, latestSnapshotContainsTarget: false },
    tools: {},
  };
  const turns = new Map(); const users = new Map(); const calls = new Map(); const contexts = [];
  let currentTurn;
  const turnOf = id => {
    const key = String(id);
    if (!turns.has(key)) turns.set(key, { key, started: false, ended: false, completed: false, flashRequest: false, flashAssistant: false, flashAssistantCount: 0, calls: [], users: [] });
    return turns.get(key);
  };
  const toolSummary = name => result.tools[name] ??= { calls: 0, succeeded: 0, failed: 0, pending: 0, targetResults: 0, emptyResults: 0 };
  for (const event of input.entries) {
    const data = object(event?.data);
    if (event?.type === 'turn/start') { currentTurn = String(data.turn); const turn = turnOf(currentTurn); turn.started = true; turn.startedAt = event.time; result.turnsStarted++; }
    if (event?.type === 'turn/end') {
      const turn = turnOf(data.turn); turn.ended = true; turn.completed = data.reason?.kind === 'completed';
      increment(result.turnOutcomes, turnOutcomes.has(data.reason?.kind) ? data.reason.kind : '[other-outcome]');
      if (currentTurn === String(data.turn)) currentTurn = undefined;
    }
    if (event?.type === 'request/context') {
      increment(result.nativeModels, modelNames.has(data.model) ? data.model : '[other-model]');
      increment(result.nativeProviders, providerNames.has(data.provider) ? data.provider : '[other-provider]');
      if (currentTurn !== undefined && data.model === 'deepseek-flash' && data.provider === 'deepseek-official') turnOf(currentTurn).flashRequest = true;
    }
    if (event?.type === 'assistant/message' && data.message?.source?.kind === 'model') {
      result.modelAssistantMessages++;
      if (data.message.source.model === 'deepseek-flash' && data.message.source.provider === 'deepseek-official') {
        const turn = turnOf(data.turn); turn.flashAssistant = true; turn.flashAssistantCount++; result.nativeFlashAssistantMessages++;
      }
    }
    if (event?.type === 'system/message') {
      const body = normalized(texts(data.message));
      if ([...modelNames].some(model => body.includes(normalized(assistantInstructions.replaceAll('{{model}}', model))))) result.behavior.bodyMatches++;
      if (data.message?.source?.sections?.some(section => section.name === 'kleio:assistant-behavior')) result.behavior.namedSectionInDurableSystemMetadata = true;
    }
    if (event?.type === 'user/message' && data.source?.kind === 'user') {
      result.directUserMessages++;
      const user = { event, turn: currentTurn };
      users.set(data.id, user);
      if (currentTurn !== undefined) turnOf(currentTurn).users.push(user);
    }
    if (event?.type === 'user/message' && data.source?.kind === 'runtime-context') {
      const sections = Array.isArray(data.source.sections) ? data.source.sections : [];
      const section = sections.find(item => item?.name === 'kleio:personal-memory');
      const targetRecords = [];
      if (section && typeof section.text === 'string') {
        result.memoryContext.namedSnapshots++;
        for (const line of section.text.split('\n')) {
          try { const row = JSON.parse(line); if (row?.id === targetId) targetRecords.push(row); } catch { /* Heading is deliberately not JSON. */ }
        }
      }
      result.memoryContext.latestSnapshotContainsTarget = targetRecords.length > 0;
      if (targetRecords.length) result.memoryContext.snapshotsContainingTarget++;
      contexts.push({ turn: currentTurn, event, records: targetRecords });
    }
    if (event?.type === 'tool/call' && toolNames.has(data.name)) {
      let args;
      try { args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : object(data.arguments); } catch { args = {}; }
      const call = { event, name: data.name, turn: String(data.turn), args, result: undefined, records: [] };
      calls.set(data.callId, call); turnOf(data.turn).calls.push(call); toolSummary(data.name).calls++;
    }
    if (event?.type === 'tool/result') {
      const call = calls.get(data.message?.toolCallId);
      if (!call) continue;
      call.result = event; call.success = data.message.isError !== true;
      const total = toolSummary(call.name);
      if (call.success) {
        total.succeeded++;
        const value = parseJsonText(data.message);
        call.empty = Array.isArray(value) && value.length === 0;
        call.records = recordsFrom(value);
        total.targetResults += call.records.length;
        if (call.empty) total.emptyResults++;
      } else total.failed++;
    }
  }
  for (const call of calls.values()) if (!call.result) toolSummary(call.name).pending++;
  result.openTurns = [...turns.values()].filter(turn => turn.started && !turn.ended).length;
  result.turns = [...turns.values()].filter(turn => turn.started).map(turn => {
    const tools = {}; for (const call of turn.calls) increment(tools, call.name);
    return { turnRef: ref(`${header.id}:${turn.key}`), completed: turn.completed, directUserMessages: turn.users.length, nativeFlashAssistantMessages: turn.flashAssistantCount, ownTools: tools };
  });
  return { header, result, turns, users, calls, contexts };
}

function bindRevision(revision, sessions) {
  const source = object(revision.source); const session = sessions.find(item => item.header.id === source.sessionId);
  const turn = session?.turns.get(String(source.turnId)); const user = session?.users.get(source.messageId);
  const toolName = operationTools[revision.operation];
  const call = turn?.calls.find(candidate => candidate.name === toolName && candidate.success && candidate.records.some(record =>
    record.id === targetId && record.version === revision.version && record.text === revision.record.text && record.deleted === revision.record.deleted && sameSource(record.source, source)));
  const checks = {
    sessionMatches: !!session,
    turnMatches: !!turn?.started,
    userMessageMatches: !!user,
    directUserInSameTurn: !!user && user.turn === String(source.turnId),
    userPrecedesTool: !!call && !!user && user.event.seq < call.event.seq,
    durableToolSucceededWithSameRecord: !!call,
    revisionAndRecordSourcesMatch: sameSource(revision.record.source, source),
  };
  return {
    version: number(revision.version), toolName: toolName ?? '[other-operation]',
    deleted: revision.record.deleted === true, factSha256: hash(revision.record.text),
    sourceRefs: { session: ref(source.sessionId), turn: ref(`${source.sessionId}:${source.turnId}`), userMessage: ref(source.messageId) },
    checks, allMatched: Object.values(checks).every(Boolean),
  };
}

function crossSessionEvidence(sessions, revisions, bindings) {
  const contexts = []; const explicitRecalls = []; const emptyRecalls = [];
  const forgetTimes = sessions.flatMap(session => [...session.calls.values()].filter(call => call.name === 'personal_memory_forget' && call.success && call.records.some(row => row.id === targetId && row.deleted)).map(call => call.result.time));
  for (const session of sessions) {
    for (const context of session.contexts) {
      for (const record of context.records) {
        const revision = revisions.find(item => item.version === record.version);
        if (!revision || revision.source.sessionId === session.header.id) continue;
        const binding = bindings.find(item => item.version === revision.version); const turn = session.turns.get(context.turn);
        contexts.push({
          destinationSessionRef: ref(session.header.id), destinationTurnRef: ref(`${session.header.id}:${context.turn}`), sourceSessionRef: ref(revision.source.sessionId), version: number(record.version),
          sameFactAsRevision: record.text === revision.record.text && record.subject === revision.record.subject && record.key === revision.record.key,
          sourceBoundToDurableUser: binding?.allMatched === true,
          nativeFlashRequest: turn?.flashRequest === true, nativeFlashAssistant: turn?.flashAssistant === true, turnCompleted: turn?.completed === true,
          explicitRecallInSameTurn: turn?.calls.some(call => call.name === 'personal_memory_recall') === true,
        });
      }
    }
    for (const call of session.calls.values()) {
      if (call.name !== 'personal_memory_recall' || !call.success) continue;
      for (const record of call.records) {
        if (record.source?.sessionId === session.header.id) continue;
        const revision = revisions.find(item => item.version === record.version);
        explicitRecalls.push({ destinationSessionRef: ref(session.header.id), sourceSessionRef: ref(record.source?.sessionId), version: number(record.version),
          sourceMatchesRevision: !!revision && sameSource(record.source, revision.source),
          factMatchesRevision: !!revision && record.text === revision.record.text,
          sourceBoundToDurableUser: bindings.some(item => item.version === record.version && item.allMatched),
        });
      }
      if (call.empty && typeof call.args?.query === 'string' && /K103\b/u.test(call.args.query)) {
        emptyRecalls.push({ sessionRef: ref(session.header.id), afterSuccessfulForget: forgetTimes.some(time => typeof time === 'number' && time < call.event.time) });
      }
    }
  }
  return { contexts, explicitRecalls, emptyRecalls };
}

async function restartEvidence(sessions, revisions) {
  // Read only the launch timestamp; never export or hash the local control/auth tokens in this file.
  let startedAt;
  try {
    const state = await readFile(join(root, '.data/native-web.json'), 'utf8');
    const match = state.match(/"startedAt"\s*:\s*"([^"\r\n]+)"/u);
    if (match) startedAt = Date.parse(match[1]);
  } catch { /* An offline Host simply has no current launch marker to correlate. */ }
  const first = revisions[0]; const savedAt = Date.parse(first?.record?.createdAt ?? '');
  const ready = Number.isFinite(startedAt) && Number.isFinite(savedAt);
  const afterRestart = sessions.some(session => session.header.id !== first?.source?.sessionId && [...session.turns.values()].some(turn =>
    turn.started && turn.completed && turn.startedAt > startedAt && (
      session.contexts.some(context => context.turn === turn.key && context.records.some(record => record.version === first?.version)) ||
      turn.calls.some(call => call.name === 'personal_memory_recall' && call.success && call.records.some(record => record.version === first?.version))
    )));
  return { method: 'launcher-startedAt-versus-first-revision-createdAt-and-durable-turn-start',
    launcherTimestampAvailable: Number.isFinite(startedAt), firstSavedBeforeCurrentLaunch: ready && savedAt < startedAt,
    completedCrossSessionRecallTurnAfterCurrentLaunch: ready && afterRestart,
    sequenceMatched: ready && savedAt < startedAt && afterRestart, independentlyProvesOSProcessIdentity: false };
}

function checkExportPrivacy(serialized, sessions, fixture, instructions) {
  const protectedValues = [targetId, instructions, ...fixture.revisions.map(revision => revision.record.text)];
  for (const session of sessions) {
    protectedValues.push(session.header.id, session.header.cwd);
    for (const user of session.users.values()) protectedValues.push(texts(user.event.data), user.event.data.id);
    for (const call of session.calls.values()) protectedValues.push(call.event.data.callId, texts(call.result?.data?.message));
  }
  for (const value of protectedValues) {
    if (typeof value !== 'string' || value.length < 20) continue;
    if (serialized.includes(JSON.stringify(value).slice(1, -1))) throw new Error('Content export was blocked.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run')) throw new Error('Unsupported evidence-reader option.');
  const dryRun = args.includes('--dry-run');
  const instructions = await readFile(join(root, 'config/assistant.md'), 'utf8');
  const files = await filesBelow(sessionRoot); const sessions = [];
  let unreadableSnapshots = 0; let skippedSessions = 0;
  for (const file of files) {
    const input = await snapshot(file);
    if (!input) { unreadableSnapshots++; continue; }
    if (!selected(input.entries)) { skippedSessions++; continue; }
    sessions.push(summarize(input, instructions));
  }
  const fixture = readFixtureDatabase();
  const bindings = fixture.revisions.map(revision => bindRevision(revision, sessions));
  const crossSession = crossSessionEvidence(sessions, fixture.revisions, bindings);
  const restart = await restartEvidence(sessions, fixture.revisions);
  const totals = { selectedSessions: sessions.length, distinctWorkspaces: new Set(sessions.map(session => session.result.workspaceRef)).size,
    turnsStarted: sessions.reduce((sum, session) => sum + session.result.turnsStarted, 0),
    completedTurns: sessions.reduce((sum, session) => sum + (session.result.turnOutcomes.completed ?? 0), 0),
    nativeFlashAssistantMessages: sessions.reduce((sum, session) => sum + session.result.nativeFlashAssistantMessages, 0),
    openTurns: sessions.reduce((sum, session) => sum + session.result.openTurns, 0),
    behaviorBodyMatches: sessions.reduce((sum, session) => sum + session.result.behavior.bodyMatches, 0),
    namedMemoryContexts: sessions.reduce((sum, session) => sum + session.result.memoryContext.namedSnapshots, 0),
    sourceMatchedRevisions: bindings.filter(binding => binding.allMatched).length,
    crossSessionContextSnapshots: crossSession.contexts.length,
    crossSessionContextOnlyCompletedFlashTurns: new Set(crossSession.contexts.filter(row => row.sameFactAsRevision && row.sourceBoundToDurableUser && row.nativeFlashRequest && row.nativeFlashAssistant && row.turnCompleted && !row.explicitRecallInSameTurn).map(row => row.destinationTurnRef)).size,
    crossSessionExplicitRecallResults: crossSession.explicitRecalls.length,
    emptyTargetRecallsAfterForget: crossSession.emptyRecalls.filter(row => row.afterSuccessfulForget).length,
    tools: {} };
  for (const session of sessions) for (const [name, counters] of Object.entries(session.result.tools)) {
    totals.tools[name] ??= { calls: 0, succeeded: 0, failed: 0, pending: 0, targetResults: 0, emptyResults: 0 };
    for (const [counter, value] of Object.entries(counters)) totals.tools[name][counter] += value;
  }
  totals.allStartedTurnsCompleted = totals.turnsStarted > 0 && totals.turnsStarted === totals.completedTurns;
  totals.ownMemoryToolCalls = Object.values(totals.tools).reduce((sum, tool) => sum + tool.calls, 0);
  totals.successfulOwnMemoryToolCalls = Object.values(totals.tools).reduce((sum, tool) => sum + tool.succeeded, 0);
  const evidence = {
    generatedAt: new Date().toISOString(),
    selection: { requiresDirectUserAcceptanceMarker: true, requiresDirectUserK103Marker: true, targetRecordRef: ref(targetId) },
    privacy: { exportsMessageText: false, exportsToolArgumentsOrResultText: false, exportsNativeIdsOrPaths: false, exportsCredentials: false },
    snapshot: { scannedFiles: files.length, skippedSessions, unreadableSnapshots, capturedAtLeastOne: sessions.length > 0,
      idle: totals.openTurns === 0 && Object.values(totals.tools).every(tool => tool.pending === 0), databaseReadOnly: true },
    behaviorAttribution: { registrationNamePersistedInSystemMessage: false, bodyVerifiedAgainstCurrentInstructionsFile: true, currentInstructionsSha256: hash(instructions) },
    database: { targetExists: !!fixture.record, version: number(fixture.record?.version), deleted: fixture.record?.deleted === true,
      revisionCount: fixture.revisions.length, targetActiveRows: fixture.activeRows, searchIndexRows: fixture.indexRows,
      allRevisionSourcesMatched: bindings.length > 0 && bindings.every(binding => binding.allMatched),
      currentRecordSourceMatchesLatestRevision: !!fixture.record && sameSource(fixture.record.source, fixture.revisions.at(-1)?.source), revisions: bindings },
    totals, restart, crossSession, sessions: sessions.map(session => session.result),
    limits: { provesSemanticAnswerAccuracy: false, provesPhysicalErasure: false, provesAutomaticMemoryExtraction: false,
      behaviorSectionNameRequiresRuntimeRegistrationEvidence: true, crossDatabaseAndSessionSnapshotIsAtomic: false },
  };
  const serialized = JSON.stringify(evidence, null, 2) + '\n';
  checkExportPrivacy(serialized, sessions, fixture, instructions);
  if (!dryRun) {
    await mkdir(dirname(outputFile), { recursive: true });
    const temporary = `${outputFile}.${process.pid}.tmp`;
    await writeFile(temporary, serialized);
    await rename(temporary, outputFile);
  }
  console.log(JSON.stringify({ dryRun, reportWritten: !dryRun, selectedSessions: sessions.length, unreadableSnapshots,
    idle: evidence.snapshot.idle, revisionCount: fixture.revisions.length, matchedRevisions: totals.sourceMatchedRevisions,
    completedTurns: totals.completedTurns, ownMemoryToolCalls: totals.ownMemoryToolCalls, successfulOwnMemoryToolCalls: totals.successfulOwnMemoryToolCalls,
    restartSequenceMatched: restart.sequenceMatched,
    behaviorBodyMatches: totals.behaviorBodyMatches, namedMemoryContexts: totals.namedMemoryContexts,
    contextOnlyCompletedFlashTurns: totals.crossSessionContextOnlyCompletedFlashTurns,
    explicitCrossSessionRecallResults: totals.crossSessionExplicitRecallResults, emptyTargetRecallsAfterForget: totals.emptyTargetRecallsAfterForget }, null, 2));
}

try { await main(); }
catch { console.error('The read-only evidence snapshot could not be completed. No source content was printed.'); process.exitCode = 1; }
