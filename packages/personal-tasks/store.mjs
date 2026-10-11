/** Durable product task state. Execution and permission decisions remain with native dsh. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export class TaskError extends Error {
  constructor(code, message) { super(message); this.name = 'TaskError'; this.code = code; }
}
const states = new Set(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']);
const terminal = new Set(['completed', 'failed', 'cancelled']);
export function cleanText(value, field, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TaskError('INVALID_INPUT', `${field} must contain 1–${max} characters.`);
  return value.trim();
}
const now = () => new Date().toISOString();
const json = row => row ? JSON.parse(row.record) : undefined;
const defaultTitle = goal => {
  const firstLine = goal.split(/\r\n|\r|\n/u, 1)[0].trim();
  // A dot inside a file name or decimal is not an English sentence boundary.
  const boundary = firstLine.search(/[。！？]|[.!?](?=\s|$)/u);
  const sentence = boundary > 0 ? firstLine.slice(0, boundary).trim() : firstLine;
  return (sentence || goal).slice(0, 80);
};

export class TaskStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS personal_tasks(id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_task_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES personal_tasks(id), session_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_task_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES personal_tasks(id), run_id TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_task_artifacts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES personal_tasks(id), run_id TEXT NOT NULL REFERENCES personal_task_runs(id), source_key TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_task_requests(request_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, action TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS personal_task_runs_task ON personal_task_runs(task_id);
      CREATE INDEX IF NOT EXISTS personal_task_events_task ON personal_task_events(task_id,seq);
    `);
  }
  close() { this.db.close(); }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const value = action(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  get(id) { const task = json(this.db.prepare('SELECT record FROM personal_tasks WHERE id=?').get(cleanText(id, 'id', 192))); if (!task) throw new TaskError('NOT_FOUND', 'Task not found.'); return task; }
  save(task) { this.db.prepare('UPDATE personal_tasks SET status=?,record=? WHERE id=?').run(task.status, JSON.stringify(task), task.id); return task; }
  event(taskId, runId, type, data = {}) {
    this.db.prepare('INSERT INTO personal_task_events(task_id,run_id,type,created_at,data) VALUES(?,?,?,?,?)').run(taskId, runId ?? null, type, now(), JSON.stringify(data));
  }
  create(input, source = {}) {
    const goal = cleanText(input.goal, 'goal', 12000); const title = input.title ? cleanText(input.title, 'title', 120) : defaultTitle(goal);
    const workspace = cleanText(input.workspace, 'workspace', 2000);
    if (!isAbsolute(workspace)) throw new TaskError('INVALID_INPUT', 'workspace must be an absolute directory.');
    const requestKey = cleanText(input.requestId || randomUUID(), 'requestId', 300);
    return this.transaction(() => {
      const existing = json(this.db.prepare('SELECT record FROM personal_tasks WHERE request_key=?').get(requestKey));
      if (existing) {
        if (existing.goal !== goal || existing.workspace !== workspace) throw new TaskError('REQUEST_CONFLICT', 'The request identity already belongs to different task content.');
        return existing;
      }
      const timestamp = now();
      const task = { id: randomUUID(), title, goal, workspace, status: 'queued', createdAt: timestamp, updatedAt: timestamp, source,
        attempt: 0, runId: null, sessionId: null, jobId: null, cancelRequested: false, uncertainEffects: false, error: null, summary: null, waitingReason: null };
      this.db.prepare('INSERT INTO personal_tasks(id,request_key,status,record) VALUES(?,?,?,?)').run(task.id, requestKey, task.status, JSON.stringify(task));
      this.event(task.id, null, 'created', { source });
      return task;
    });
  }
  list({ limit = 100, status } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (status && !states.has(status))) throw new TaskError('INVALID_INPUT', 'Invalid task query.');
    return (status ? this.db.prepare('SELECT record FROM personal_tasks WHERE status=? ORDER BY rowid DESC LIMIT ?').all(status, limit) : this.db.prepare('SELECT record FROM personal_tasks ORDER BY rowid DESC LIMIT ?').all(limit)).map(json);
  }
  runs(id) { this.get(id); return this.db.prepare('SELECT record FROM personal_task_runs WHERE task_id=? ORDER BY rowid').all(id).map(json); }
  run(id) { return json(this.db.prepare('SELECT record FROM personal_task_runs WHERE id=?').get(id)); }
  bySession(sessionId) { const run = json(this.db.prepare('SELECT record FROM personal_task_runs WHERE session_id=?').get(sessionId)); return run ? { run, task: this.get(run.taskId) } : undefined; }
  unsettled() { return this.db.prepare("SELECT record FROM personal_tasks WHERE status IN ('running','waiting')").all().map(json); }
  saveRun(run) { this.db.prepare('UPDATE personal_task_runs SET record=? WHERE id=?').run(JSON.stringify(run), run.id); return run; }
  detail(id) {
    return { task: this.get(id), runs: this.runs(id), events: this.db.prepare('SELECT seq,run_id,type,created_at,data FROM personal_task_events WHERE task_id=? ORDER BY seq DESC LIMIT 300').all(id)
      .reverse().map(row => ({ seq: row.seq, runId: row.run_id, type: row.type, createdAt: row.created_at, data: JSON.parse(row.data) })), artifacts: this.artifacts({ taskId: id }) };
  }
  start(id, sessionId) {
    return this.transaction(() => {
      const task = this.get(id); if (task.status !== 'queued') throw new TaskError('STATE_CONFLICT', 'Only queued tasks can start.');
      const timestamp = now(); const run = { id: randomUUID(), taskId: id, sessionId, attempt: task.attempt + 1, status: 'running', createdAt: timestamp,
        finishedAt: null, finishReceipt: null, nativeTurn: null, dispatched: false, uncertainEffects: false };
      this.db.prepare('INSERT INTO personal_task_runs(id,task_id,session_id,record) VALUES(?,?,?,?)').run(run.id, id, sessionId, JSON.stringify(run));
      this.save({ ...task, runId: run.id, sessionId, attempt: run.attempt, status: 'running', updatedAt: timestamp, cancelRequested: false, waitingReason: null, error: null });
      this.event(id, run.id, 'started', { sessionId }); return run;
    });
  }
  update(id, runId, patch, type, data = {}) {
    return this.transaction(() => {
      const task = this.get(id); if (task.runId !== runId) return task;
      const next = { ...task, ...patch, updatedAt: now() };
      if (!states.has(next.status)) throw new TaskError('INVALID_STATE', 'Invalid task state.');
      this.save(next); if (type) this.event(id, runId, type, data); return next;
    });
  }
  setJob(id, runId, jobId) { return this.update(id, runId, { jobId }, 'native-job', { jobId }); }
  dispatched(runId) { const run = this.run(runId); if (run) this.saveRun({ ...run, dispatched: true }); }
  finishReceipt(runId, receipt) {
    return this.transaction(() => {
      const run = this.run(runId); const task = run && this.get(run.taskId);
      if (!run || task.runId !== runId || terminal.has(task.status) || task.cancelRequested) throw new TaskError('STATE_CONFLICT', 'The task cannot accept completion.');
      this.saveRun({ ...run, finishReceipt: receipt }); this.event(task.id, runId, 'finish-receipt', receipt); return receipt;
    });
  }
  settle(runId, status, details = {}) {
    return this.transaction(() => {
      const run = this.run(runId); if (!run) return;
      const task = this.get(run.taskId); if (task.runId !== runId || terminal.has(task.status)) return task;
      if (status === 'completed' && !run.finishReceipt) throw new TaskError('MISSING_RECEIPT', 'Completion requires a verified explicit receipt.');
      // A persisted cancellation request is not proof that an interrupted native execution stopped.
      const nextStatus = task.cancelRequested && details.waitingReason !== 'host-interrupted' ? 'cancelled' : status; const timestamp = now();
      this.saveRun({ ...run, status: nextStatus, finishedAt: timestamp, uncertainEffects: details.uncertainEffects === true, nativeTurn: details.turn ?? run.nativeTurn });
      const next = { ...task, status: nextStatus, updatedAt: timestamp, error: details.error ?? null, waitingReason: details.waitingReason ?? null,
        uncertainEffects: details.uncertainEffects === true, summary: nextStatus === 'completed' ? run.finishReceipt.summary : task.summary };
      this.save(next); this.event(task.id, runId, nextStatus, { ...details }); return next;
    });
  }
  requestCancel(id) {
    const task = this.get(id); if (terminal.has(task.status)) return task;
    if (task.status === 'queued') return this.update(id, task.runId, { status: 'cancelled', cancelRequested: true }, 'cancelled');
    return this.update(id, task.runId, { cancelRequested: true, waitingReason: 'cancelling' }, 'cancel-requested');
  }
  retry(id, { requestId, acknowledgeUncertainEffects = false } = {}) {
    const key = cleanText(requestId || randomUUID(), 'requestId', 300);
    return this.transaction(() => {
      const seen = this.db.prepare('SELECT task_id,action FROM personal_task_requests WHERE request_key=?').get(key);
      if (seen) { if (seen.task_id !== id || seen.action !== 'retry') throw new TaskError('REQUEST_CONFLICT', 'Request identity conflict.'); return this.get(id); }
      const task = this.get(id);
      if (!['failed', 'cancelled', 'waiting'].includes(task.status)) throw new TaskError('STATE_CONFLICT', 'Only a stopped task can be explicitly retried.');
      if (task.waitingReason === 'approval' || task.waitingReason === 'cancelling') throw new TaskError('TASK_ACTIVE', 'Resolve or stop the native execution first.');
      const last = task.runId && this.run(task.runId);
      if ((task.uncertainEffects || last?.dispatched) && acknowledgeUncertainEffects !== true) throw new TaskError('INSPECTION_REQUIRED', 'Inspect the earlier execution and explicitly acknowledge possible effects before retrying.');
      const next = { ...task, status: 'queued', runId: null, sessionId: null, jobId: null, cancelRequested: false, uncertainEffects: false,
        waitingReason: null, error: null, summary: null, updatedAt: now() };
      this.save(next); this.db.prepare('INSERT INTO personal_task_requests(request_key,task_id,action) VALUES(?,?,?)').run(key, id, 'retry');
      this.event(id, last?.id, 'retry-requested', { acknowledgeUncertainEffects: acknowledgeUncertainEffects === true }); return next;
    });
  }
  artifact(runId, value) {
    return this.transaction(() => {
      const run = this.run(runId); if (!run) throw new TaskError('NOT_FOUND', 'Task run not found.');
      const sourceKey = `${run.sessionId}:${value.eventSeq}:${value.path}`;
      const previous = json(this.db.prepare('SELECT record FROM personal_task_artifacts WHERE source_key=?').get(sourceKey)); if (previous) return previous;
      const artifact = { ...value, id: randomUUID(), taskId: run.taskId, runId, sessionId: run.sessionId, kind: 'file', createdAt: now() };
      this.db.prepare('INSERT INTO personal_task_artifacts(id,task_id,run_id,source_key,record) VALUES(?,?,?,?,?)').run(artifact.id, run.taskId, runId, sourceKey, JSON.stringify(artifact));
      this.event(run.taskId, runId, 'artifact', { artifactId: artifact.id }); return artifact;
    });
  }
  artifacts({ taskId, runId, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TaskError('INVALID_INPUT', 'Invalid artifact limit.');
    if (runId) return this.db.prepare('SELECT record FROM personal_task_artifacts WHERE run_id=? ORDER BY rowid DESC LIMIT ?').all(runId, limit).map(json);
    if (taskId) return this.db.prepare('SELECT record FROM personal_task_artifacts WHERE task_id=? ORDER BY rowid DESC LIMIT ?').all(taskId, limit).map(json);
    return this.db.prepare('SELECT record FROM personal_task_artifacts ORDER BY rowid DESC LIMIT ?').all(limit).map(json);
  }
  getArtifact(id) { const artifact = json(this.db.prepare('SELECT record FROM personal_task_artifacts WHERE id=?').get(cleanText(id, 'id', 192))); if (!artifact) throw new TaskError('NOT_FOUND', 'Result not found.'); return artifact; }
  recoverInterrupted() {
    // There is no attempt to reconstruct model position or replay unknown external work.
    for (const task of this.unsettled()) if (task.status === 'running' || (task.status === 'waiting' && ['approval', 'cancelling'].includes(task.waitingReason))) {
      if (task.runId) this.settle(task.runId, 'waiting', { waitingReason: 'host-interrupted', uncertainEffects: true, error: 'Host stopped before execution settled. Inspect the native session before an explicit retry.' });
    }
  }
}
