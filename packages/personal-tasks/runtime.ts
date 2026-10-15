import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type WorkKind = 'research' | 'reminder';
export type WorkStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'failed' | 'unknown';
export type WorkRunStatus = 'running' | 'review_pending' | 'reviewing' | 'completed' | 'cancelled' | 'failed' | 'unknown';
/** User-facing progress for one one-shot research. Reading is not one of these. */
export type WorkProgress = 'queued' | 'running' | 'review' | 'written' | 'stopped' | 'failed' | 'unknown';
export const workProgressLabels: Record<WorkProgress, string> = {
  queued: '排队', running: '进行中', review: '复核', written: '已写入', stopped: '已停止', failed: '失败', unknown: '结果未知',
};

/** Supplied by the authenticated product command layer, never parsed from task text. */
export interface WorkSource {
  kind: 'user';
  conversationId: string;
  messageId: string;
}
export interface CreateWork {
  requestId: string;
  title: string;
  prompt: string;
  kind: WorkKind;
  at?: string;
  intervalMs?: number;
  conversationId?: string;
}
export interface WorkTask {
  id: string;
  requestId: string;
  title: string;
  prompt: string;
  kind: WorkKind;
  source: WorkSource;
  conversationId: string;
  status: WorkStatus;
  version: number;
  at: string;
  requestedAt: string | null;
  intervalMs: number | null;
  nextAt: string | null;
  lastRunId: string | null;
  /** Agreement version. A new prompt, title, or time appends a constraint; pause and stop do not. */
  constraintVersion: number;
  constraints: WorkConstraint[];
  createdAt: string;
  updatedAt: string;
}
export interface WorkConstraint {
  version: number;
  title: string;
  prompt: string;
  at: string;
  source: WorkSource;
  createdAt: string;
}
export interface WorkRun {
  id: string;
  taskId: string;
  occurrenceAt: string;
  status: WorkRunStatus;
  version: number;
  taskVersion: number;
  claimToken: string | null;
  reviewAttempts: number;
  reviewAfter: string | null;
  errorCode: string | null;
  /** Agreement captured when the run was claimed. Later condition changes do not adopt this run. */
  constraintVersion: number;
  createdAt: string;
  updatedAt: string;
}
export interface WorkEvidence { kind: 'url' | 'file' | 'note'; reference: string; title?: string; }
export interface ResearchResult { text: string; sessionId?: string; evidence?: WorkEvidence[]; }
export interface StoredResearchResult extends ResearchResult { id: string; runId: string; taskId: string; createdAt: string; }
export interface WorkDelivery {
  id: string;
  taskId: string;
  runId: string;
  constraintVersion: number;
  conversationId: string;
  messageId: string;
  writtenAt: string;
  readAt: string | null;
  text: string;
  evidence: WorkEvidence[];
}
export interface WorkDeliveryRequest {
  taskId: string;
  runId: string;
  conversationId: string;
  constraintVersion: number;
  text: string;
  evidence: WorkEvidence[];
}
export interface ResearchSnapshot {
  task: WorkTask;
  progress: WorkProgress;
  progressLabel: string;
  /** Distinguishes a resumable pause from a terminal stop. Progress stays 已停止 for both. */
  hold: 'paused' | 'cancelled' | null;
  delivered: boolean;
  read: boolean;
  errorCode: string | null;
  delivery: WorkDelivery | null;
}
export interface ReviseWork { title?: string; prompt?: string; at?: string; }
export interface WorkReview { decision: 'silent' | 'notify'; text: string; }
export interface StoredWorkReview extends WorkReview { id: string; resultId: string; runId: string; taskId: string; createdAt: string; }
export interface WorkNotification {
  id: string;
  taskId: string;
  runId: string;
  conversationId: string;
  kind: WorkKind;
  title: string;
  text: string;
  resultId: string | null;
  reviewId: string | null;
  createdAt: string;
  readAt: string | null;
}
export interface WorkExecution { task: WorkTask; run: WorkRun; signal: AbortSignal; }
export interface ReviewHandoff extends WorkExecution { result: StoredResearchResult; }
export interface WorkCallbacks {
  /** One engine execution. The caller owns its tool policy, budget and cancellation. */
  runResearch: (work: WorkExecution) => Promise<ResearchResult>;
  /** Read-only main-agent review. Safe to repeat after an interrupted review. */
  review: (handoff: ReviewHandoff) => Promise<WorkReview>;
  /** Writes the finished one-shot report into the original conversation. Must use the caller's current transaction. */
  deliver?: (input: WorkDeliveryRequest) => { messageId: string };
}
export interface WorkTickResult { reminders: number; researched: number; reviewed: number; failed: number; stale: number; }
export class WorkRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WorkRuntimeError'; }
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new WorkRuntimeError('INVALID_INPUT', `${name} must contain 1–${max} characters.`);
  return value.trim();
}
function iso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new WorkRuntimeError('INVALID_INPUT', 'at must be an ISO timestamp with an explicit time zone.');
  }
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const days = month === 2 ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > days) throw new WorkRuntimeError('INVALID_INPUT', 'at must contain a valid calendar date.');
  return new Date(value).toISOString();
}
function limit(value: number | undefined, fallback = 100): number {
  const count = value ?? fallback;
  if (!Number.isSafeInteger(count) || count < 1 || count > 200) throw new WorkRuntimeError('INVALID_INPUT', 'limit must be an integer between 1 and 200.');
  return count;
}
function row<T>(value: unknown): T | undefined {
  return value ? JSON.parse((value as { record: string }).record) as T : undefined;
}
function oneShotResearch(task: WorkTask): boolean {
  return task.kind === 'research' && task.intervalMs === null;
}
function sourceUrl(value: unknown): string {
  const reference = text(value, 'evidence.reference', 4000);
  let url: URL;
  try { url = new URL(reference); } catch { throw new WorkRuntimeError('INVALID_RESULT', 'Research evidence must use an http(s) source URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WorkRuntimeError('INVALID_RESULT', 'Research evidence must use an http(s) source URL.');
  return reference;
}
/** Keeps only searched source links in the conversation report. */
export function formatResearchDelivery(text: string, evidence: WorkEvidence[]): string {
  const urls = evidence.filter(item => item.kind === 'url');
  const allowed = new Set(urls.map(item => item.reference));
  const body = text.replace(/https?:\/\/[^\s)>\]]+/gu, url => allowed.has(url) ? url : '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  const lines = urls.map(item => {
    const title = (item.title ?? item.reference).replace(/[\[\]\r\n]/g, '').trim().slice(0, 300) || item.reference;
    return `- [${title}](${item.reference})`;
  });
  return `${body || '研究结论见下列来源。'}\n\n来源\n${lines.join('\n')}`;
}

/**
 * Product-owned durable work; the caller owns the shared database and process lease.
 * Construct once on startup. No database close, host timer, model loop or tool loop.
 * Interval catch-up coalesces missed occurrences and never overlaps a task's runs.
 */
export class WorkRuntime {
  private readonly active = new Map<string, AbortController>();
  private transactionSerial = 0;
  private readonly clock: () => number;
  private readonly maxConcurrent: number;
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly db: DatabaseSync, options: { now?: () => number; recover?: boolean; maxConcurrent?: number } = {}) {
    this.clock = options.now ?? Date.now;
    this.maxConcurrent = limit(options.maxConcurrent, 2);
    db.exec(`
      CREATE TABLE IF NOT EXISTS kw_tasks(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, next_at TEXT, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kw_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES kw_tasks(id), occurrence_at TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(task_id,occurrence_at));
      CREATE TABLE IF NOT EXISTS kw_results(id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES kw_runs(id), task_id TEXT NOT NULL REFERENCES kw_tasks(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kw_reviews(id TEXT PRIMARY KEY, result_id TEXT NOT NULL UNIQUE REFERENCES kw_results(id), run_id TEXT NOT NULL UNIQUE REFERENCES kw_runs(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kw_notifications(id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES kw_runs(id), task_id TEXT NOT NULL REFERENCES kw_tasks(id), read_at TEXT, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kw_deliveries(id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES kw_runs(id), task_id TEXT NOT NULL REFERENCES kw_tasks(id), constraint_version INTEGER NOT NULL, written_at TEXT, read_at TEXT, record TEXT NOT NULL, UNIQUE(task_id, constraint_version));
      CREATE INDEX IF NOT EXISTS kw_tasks_due ON kw_tasks(status,next_at);
      CREATE INDEX IF NOT EXISTS kw_runs_task ON kw_runs(task_id,status);
    `);
    if (options.recover !== false) this.recover();
  }

  private timestamp(): string {
    const value = this.clock();
    if (!Number.isSafeInteger(value)) throw new WorkRuntimeError('INVALID_CLOCK', 'The work clock must return epoch milliseconds.');
    return new Date(value).toISOString();
  }
  private transaction<T>(action: () => T): T {
    const name = `kw_transaction_${++this.transactionSerial}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const value = action(); this.db.exec(`RELEASE ${name}`); return value; }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  private saveTask(task: WorkTask): WorkTask {
    this.db.prepare('UPDATE kw_tasks SET status=?,next_at=?,record=? WHERE id=?').run(task.status, task.nextAt, JSON.stringify(task), task.id);
    return task;
  }
  private saveRun(run: WorkRun): WorkRun {
    this.db.prepare('UPDATE kw_runs SET status=?,record=? WHERE id=?').run(run.status, JSON.stringify(run), run.id);
    return run;
  }
  private present(task: WorkTask): WorkTask {
    const constraintVersion = task.constraintVersion || 1;
    const constraints = Array.isArray(task.constraints) && task.constraints.length
      ? task.constraints
      : [{ version: constraintVersion, title: task.title, prompt: task.prompt, at: task.at, source: task.source, createdAt: task.createdAt }];
    if (task.constraintVersion === constraintVersion && task.constraints === constraints) return task;
    return { ...task, constraintVersion, constraints };
  }
  private presentRun(run: WorkRun): WorkRun {
    return run.constraintVersion ? run : { ...run, constraintVersion: 1 };
  }
  get(id: string): WorkTask {
    const value = row<WorkTask>(this.db.prepare('SELECT record FROM kw_tasks WHERE id=?').get(text(id, 'id', 192)));
    if (!value) throw new WorkRuntimeError('NOT_FOUND', 'Work task not found.');
    return this.present(value);
  }
  list(options: { limit?: number; status?: WorkStatus } = {}): WorkTask[] {
    if (options.status !== undefined && !['active', 'paused', 'completed', 'cancelled', 'failed', 'unknown'].includes(options.status)) throw new WorkRuntimeError('INVALID_INPUT', 'Invalid task status.');
    const count = limit(options.limit);
    return (options.status === undefined
      ? this.db.prepare('SELECT record FROM kw_tasks ORDER BY rowid DESC LIMIT ?').all(count)
      : this.db.prepare('SELECT record FROM kw_tasks WHERE status=? ORDER BY rowid DESC LIMIT ?').all(options.status, count)).map(value => this.present(row<WorkTask>(value)!));
  }
  runs(taskId: string): WorkRun[] {
    this.get(taskId);
    return this.db.prepare('SELECT record FROM kw_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 200').all(taskId).map(value => this.presentRun(row<WorkRun>(value)!));
  }
  result(runId: string): StoredResearchResult | undefined { return row<StoredResearchResult>(this.db.prepare('SELECT record FROM kw_results WHERE run_id=?').get(text(runId, 'runId', 192))); }
  reviewResult(runId: string): StoredWorkReview | undefined { return row<StoredWorkReview>(this.db.prepare('SELECT record FROM kw_reviews WHERE run_id=?').get(text(runId, 'runId', 192))); }
  private run(id: string): WorkRun {
    const value = row<WorkRun>(this.db.prepare('SELECT record FROM kw_runs WHERE id=?').get(id));
    if (!value) throw new WorkRuntimeError('NOT_FOUND', 'Work run not found.');
    return this.presentRun(value);
  }
  private assertOneShot(task: WorkTask): void {
    if (!oneShotResearch(task)) throw new WorkRuntimeError('ONE_SHOT_ONLY', 'Pause, resume, and new conditions apply only to one one-shot research task.');
  }
  private expectVersion(task: WorkTask, expectedVersion?: number): void {
    if (expectedVersion !== undefined && task.version !== expectedVersion) throw new WorkRuntimeError('STALE_VERSION', 'The task has changed.');
  }
  private supersedeRuns(taskId: string, timestamp: string, errorCode: string | null): void {
    for (const value of this.db.prepare("SELECT record FROM kw_runs WHERE task_id=? AND status IN ('running','review_pending','reviewing')").all(taskId)) {
      const run = this.presentRun(row<WorkRun>(value)!);
      this.saveRun({ ...run, status: 'cancelled', version: run.version + 1, claimToken: null, errorCode, updatedAt: timestamp });
    }
  }
  private abortSuperseded(taskId: string): void {
    for (const run of this.runs(taskId)) if (run.status === 'cancelled') this.active.get(run.id)?.abort('work superseded');
  }
  private deliveryForConstraint(taskId: string, constraintVersion: number): WorkDelivery | undefined {
    return row<WorkDelivery>(this.db.prepare('SELECT record FROM kw_deliveries WHERE task_id=? AND constraint_version=?').get(taskId, constraintVersion));
  }
  deliveries(taskId: string): WorkDelivery[] {
    this.get(taskId);
    return this.db.prepare('SELECT record FROM kw_deliveries WHERE task_id=? ORDER BY rowid').all(taskId).map(value => row<WorkDelivery>(value)!);
  }

  create(input: CreateWork, source: WorkSource): WorkTask {
    if (this.stopping) throw new WorkRuntimeError('HOST_STOPPING', 'The work host is stopping.');
    if (!source || source.kind !== 'user') throw new WorkRuntimeError('SOURCE_REQUIRED', 'A direct user delegation is required.');
    const origin: WorkSource = { kind: 'user', conversationId: text(source.conversationId, 'source.conversationId', 192), messageId: text(source.messageId, 'source.messageId', 192) };
    const requestId = text(input.requestId, 'requestId', 300);
    const title = text(input.title, 'title', 120);
    const prompt = text(input.prompt, 'prompt', 12000);
    if (input.kind !== 'research' && input.kind !== 'reminder') throw new WorkRuntimeError('INVALID_INPUT', 'Invalid work kind.');
    const intervalMs = input.intervalMs ?? null;
    if (intervalMs !== null && (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 365 * 86400000)) throw new WorkRuntimeError('INVALID_INPUT', 'intervalMs must be between one second and one year.');
    const conversationId = input.conversationId === undefined ? origin.conversationId : text(input.conversationId, 'conversationId', 192);
    const explicitAt = input.at === undefined ? undefined : iso(input.at);
    return this.transaction(() => {
      const existing = row<WorkTask>(this.db.prepare('SELECT record FROM kw_tasks WHERE request_id=?').get(requestId));
      if (existing) {
        if (existing.title !== title || existing.prompt !== prompt || existing.kind !== input.kind || existing.intervalMs !== intervalMs || existing.conversationId !== conversationId || JSON.stringify(existing.source) !== JSON.stringify(origin) || existing.requestedAt !== (explicitAt ?? null)) {
          throw new WorkRuntimeError('REQUEST_CONFLICT', 'The request identity belongs to different work.');
        }
        return this.present(existing);
      }
      const timestamp = this.timestamp();
      const at = explicitAt ?? (intervalMs === null ? timestamp : new Date(Date.parse(timestamp) + intervalMs).toISOString());
      const constraint: WorkConstraint = { version: 1, title, prompt, at, source: origin, createdAt: timestamp };
      const task: WorkTask = { id: randomUUID(), requestId, title, prompt, kind: input.kind, source: origin, conversationId, status: 'active', version: 1, constraintVersion: 1, constraints: [constraint], at, requestedAt: explicitAt ?? null, intervalMs, nextAt: at, lastRunId: null, createdAt: timestamp, updatedAt: timestamp };
      this.db.prepare('INSERT INTO kw_tasks(id,request_id,status,next_at,record) VALUES(?,?,?,?,?)').run(task.id, requestId, task.status, at, JSON.stringify(task));
      return task;
    });
  }

  cancel(id: string, expectedVersion?: number): WorkTask {
    const task = this.transaction(() => {
      const current = this.get(id);
      if (expectedVersion !== undefined && current.version !== expectedVersion) throw new WorkRuntimeError('STALE_VERSION', 'The task has changed.');
      if (current.status === 'cancelled' || current.status === 'completed') return current;
      const timestamp = this.timestamp();
      this.supersedeRuns(id, timestamp, null);
      return this.saveTask({ ...current, status: 'cancelled', version: current.version + 1, nextAt: null, updatedAt: timestamp });
    });
    this.abortSuperseded(id);
    return task;
  }

  pause(id: string, expectedVersion?: number): WorkTask {
    const task = this.transaction(() => {
      const current = this.get(id);
      this.assertOneShot(current);
      this.expectVersion(current, expectedVersion);
      if (current.status === 'paused' || current.status === 'cancelled' || current.status === 'completed') return current;
      if (current.status !== 'active') throw new WorkRuntimeError('INVALID_STATE', 'Only an active one-shot research can be paused.');
      const timestamp = this.timestamp();
      this.supersedeRuns(id, timestamp, 'SUPERSEDED');
      return this.saveTask({ ...current, status: 'paused', version: current.version + 1, nextAt: null, updatedAt: timestamp });
    });
    this.abortSuperseded(id);
    return task;
  }

  resume(id: string, expectedVersion?: number): WorkTask {
    const task = this.transaction(() => {
      const current = this.get(id);
      this.assertOneShot(current);
      this.expectVersion(current, expectedVersion);
      if (current.status !== 'paused') throw new WorkRuntimeError('INVALID_STATE', 'Only a paused one-shot research can be resumed.');
      const timestamp = this.timestamp();
      this.supersedeRuns(id, timestamp, 'SUPERSEDED');
      const at = Date.parse(current.at) > Date.parse(timestamp) ? current.at : timestamp;
      return this.saveTask({ ...current, status: 'active', version: current.version + 1, nextAt: at, updatedAt: timestamp });
    });
    this.abortSuperseded(id);
    return task;
  }

  /** Replaces conditions on the same task. An in-flight run of the previous agreement cannot be written. */
  revise(id: string, input: ReviseWork, source: WorkSource, expectedVersion?: number): WorkTask {
    if (!source || source.kind !== 'user') throw new WorkRuntimeError('SOURCE_REQUIRED', 'A direct user delegation is required.');
    const origin: WorkSource = { kind: 'user', conversationId: text(source.conversationId, 'source.conversationId', 192), messageId: text(source.messageId, 'source.messageId', 192) };
    const task = this.transaction(() => {
      const current = this.get(id);
      this.assertOneShot(current);
      this.expectVersion(current, expectedVersion);
      if (current.status === 'cancelled') throw new WorkRuntimeError('INVALID_STATE', 'Stopped research cannot take new conditions.');
      const title = input.title === undefined ? current.title : text(input.title, 'title', 120);
      const prompt = input.prompt === undefined ? current.prompt : text(input.prompt, 'prompt', 12000);
      const at = input.at === undefined ? current.at : iso(input.at);
      if (title === current.title && prompt === current.prompt && at === current.at) return current;
      const timestamp = this.timestamp();
      this.supersedeRuns(id, timestamp, 'SUPERSEDED');
      const constraintVersion = current.constraintVersion + 1;
      const constraint: WorkConstraint = { version: constraintVersion, title, prompt, at, source: origin, createdAt: timestamp };
      const status: WorkStatus = current.status === 'paused' ? 'paused' : 'active';
      const nextAt = status === 'paused' ? null : (Date.parse(at) > Date.parse(timestamp) ? at : timestamp);
      return this.saveTask({ ...current, title, prompt, at, requestedAt: input.at === undefined ? current.requestedAt : at, status, version: current.version + 1, constraintVersion, constraints: [...current.constraints, constraint], nextAt, updatedAt: timestamp });
    });
    this.abortSuperseded(id);
    return task;
  }

  snapshot(id: string): ResearchSnapshot {
    const task = this.get(id);
    this.assertOneShot(task);
    const delivery = this.deliveryForConstraint(task.id, task.constraintVersion) ?? null;
    const run = this.currentRun(task, this.runs(id));
    const progress = this.progressOf(task, run, delivery);
    return { task, progress, progressLabel: workProgressLabels[progress], hold: task.status === 'paused' ? 'paused' : task.status === 'cancelled' ? 'cancelled' : null, delivered: delivery !== null, read: Boolean(delivery?.readAt), errorCode: run?.errorCode ?? null, delivery };
  }
  private currentRun(task: WorkTask, runs: WorkRun[]): WorkRun | undefined {
    const same = runs.filter(run => run.constraintVersion === task.constraintVersion && run.status !== 'cancelled');
    return same.find(run => run.status === 'running' || run.status === 'review_pending' || run.status === 'reviewing')
      ?? same.find(run => run.status === 'failed' || run.status === 'unknown')
      ?? same.find(run => run.status === 'completed');
  }
  private progressOf(task: WorkTask, run: WorkRun | undefined, delivery: WorkDelivery | null): WorkProgress {
    if (task.status === 'cancelled' || task.status === 'paused') return 'stopped';
    if (delivery?.writtenAt && delivery.messageId) return 'written';
    if (task.status === 'failed' || run?.status === 'failed') return 'failed';
    if (task.status === 'unknown' || run?.status === 'unknown') return 'unknown';
    if (run?.status === 'reviewing' || run?.status === 'review_pending') return 'review';
    if (run?.status === 'running') return 'running';
    if (task.status === 'completed') return 'unknown';
    return 'queued';
  }
  /** Marks the written session result as read. A result that was never written is not delivered. */
  markRead(id: string): WorkDelivery {
    return this.transaction(() => {
      const task = this.get(id);
      this.assertOneShot(task);
      const delivery = this.deliveryForConstraint(task.id, task.constraintVersion);
      if (!delivery?.writtenAt || !delivery.messageId) throw new WorkRuntimeError('NOT_DELIVERED', 'Research is not delivered until it is written to the original conversation.');
      if (delivery.readAt !== null) return delivery;
      const next = { ...delivery, readAt: this.timestamp() };
      this.db.prepare('UPDATE kw_deliveries SET read_at=?,record=? WHERE id=?').run(next.readAt, JSON.stringify(next), next.id);
      return next;
    });
  }

  /** Startup recovery: research is never replayed; persisted read-only reviews may resume. */
  recover(): { unknown: number; reviews: number } {
    if (this.active.size) throw new WorkRuntimeError('WORK_ACTIVE', 'Recovery cannot run while local work is active.');
    return this.transaction(() => {
      let unknown = 0, reviews = 0;
      const timestamp = this.timestamp();
      for (const value of this.db.prepare("SELECT record FROM kw_runs WHERE status IN ('running','reviewing')").all()) {
        const current = row<WorkRun>(value)!;
        const task = this.get(current.taskId);
        if (current.status === 'running') {
          this.saveRun({ ...current, status: 'unknown', version: current.version + 1, claimToken: null, errorCode: 'HOST_INTERRUPTED', updatedAt: timestamp });
          this.saveTask({ ...task, status: 'unknown', version: task.version + 1, nextAt: null, updatedAt: timestamp });
          unknown++;
        } else {
          this.saveRun({ ...current, status: task.status === 'active' ? 'review_pending' : 'cancelled', version: current.version + 1, claimToken: null, reviewAfter: timestamp, updatedAt: timestamp });
          reviews++;
        }
      }
      return { unknown, reviews };
    });
  }

  private claimDue(id: string, timestamp: string): WorkExecution | undefined {
    return this.transaction(() => {
      const task = this.get(id);
      if (task.status !== 'active' || task.nextAt === null || task.nextAt > timestamp) return undefined;
      if (this.db.prepare("SELECT id FROM kw_runs WHERE task_id=? AND status IN ('running','review_pending','reviewing') LIMIT 1").get(id)) return undefined;
      const due = Date.parse(task.nextAt);
      const occurrence = task.intervalMs === null ? due : due + Math.floor((Date.parse(timestamp) - due) / task.intervalMs) * task.intervalMs;
      let occurrenceAt = new Date(occurrence).toISOString();
      // A cancelled or completed one-shot still occupies this due instant. The replacement agreement needs its own run.
      if (task.intervalMs === null && this.db.prepare('SELECT 1 FROM kw_runs WHERE task_id=? AND occurrence_at=?').get(id, occurrenceAt)) {
        occurrenceAt = `${occurrenceAt}#${task.constraintVersion}.${task.version}`;
      }
      const nextAt = task.intervalMs === null ? null : new Date(occurrence + task.intervalMs).toISOString();
      const run: WorkRun = { id: randomUUID(), taskId: id, occurrenceAt, status: 'running', version: 1, taskVersion: task.version, constraintVersion: task.constraintVersion, claimToken: randomUUID(), reviewAttempts: 0, reviewAfter: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp };
      this.db.prepare('INSERT INTO kw_runs(id,task_id,occurrence_at,status,record) VALUES(?,?,?,?,?)').run(run.id, id, occurrenceAt, run.status, JSON.stringify(run));
      const next = this.saveTask({ ...task, nextAt, lastRunId: run.id, updatedAt: timestamp });
      if (task.kind === 'reminder') {
        this.notify(next, run, task.prompt, null, null, timestamp);
        this.saveRun({ ...run, status: 'completed', version: 2, claimToken: null, updatedAt: timestamp });
        if (nextAt === null) this.saveTask({ ...next, status: 'completed', updatedAt: timestamp });
        return { task: next, run, signal: AbortSignal.abort('fixed reminder delivered') };
      }
      const controller = new AbortController();
      this.active.set(run.id, controller);
      return { task: next, run, signal: controller.signal };
    });
  }

  private currentClaim(work: WorkExecution, status: WorkRunStatus): boolean {
    if (this.stopping || work.signal.aborted) return false;
    const task = this.get(work.task.id), run = this.run(work.run.id);
    return task.status === 'active' && task.version === work.run.taskVersion && task.constraintVersion === work.run.constraintVersion && run.status === status && run.version === work.run.version && run.claimToken === work.run.claimToken;
  }
  private storeResult(work: WorkExecution, output: ResearchResult): boolean {
    if (this.stopping || work.signal.aborted) return false;
    const resultText = text(output.text, 'result.text', 100000);
    const sessionId = output.sessionId === undefined ? undefined : text(output.sessionId, 'result.sessionId', 192);
    if (output.evidence !== undefined && (!Array.isArray(output.evidence) || output.evidence.length > 100)) throw new WorkRuntimeError('INVALID_RESULT', 'Invalid research evidence.');
    const evidence = output.evidence?.map(item => {
      if (!item || (item.kind !== 'url' && item.kind !== 'file' && item.kind !== 'note')) throw new WorkRuntimeError('INVALID_RESULT', 'Invalid evidence kind.');
      const reference = item.kind === 'url' ? sourceUrl(item.reference) : text(item.reference, 'evidence.reference', 4000);
      const title = typeof item.title === 'string' && item.title.trim() ? text(item.title, 'evidence.title', 300) : undefined;
      return { kind: item.kind, reference, ...(title === undefined ? {} : { title }) };
    });
    return this.transaction(() => {
      if (!this.currentClaim(work, 'running')) return false;
      const task = this.get(work.task.id);
      if (oneShotResearch(task) && !(evidence ?? []).some(item => item.kind === 'url')) throw new WorkRuntimeError('UNSOURCED_RESULT', 'One-shot research requires at least one source URL from web search.');
      const timestamp = this.timestamp();
      const stored: StoredResearchResult = { id: randomUUID(), runId: work.run.id, taskId: work.task.id, text: resultText, ...(sessionId === undefined ? {} : { sessionId }), ...(evidence === undefined ? {} : { evidence }), createdAt: timestamp };
      this.db.prepare('INSERT INTO kw_results(id,run_id,task_id,record) VALUES(?,?,?,?)').run(stored.id, stored.runId, stored.taskId, JSON.stringify(stored));
      this.saveRun({ ...work.run, status: 'review_pending', version: work.run.version + 1, claimToken: null, reviewAfter: timestamp, updatedAt: timestamp });
      return true;
    });
  }
  private claimReview(id: string): ReviewHandoff | undefined {
    return this.transaction(() => {
      const run = this.run(id), task = this.get(run.taskId), timestamp = this.timestamp();
      if (run.status !== 'review_pending') return undefined;
      const waiting = run.reviewAfter !== null && run.reviewAfter > timestamp;
      const agreement = task.status === 'active' && task.version === run.taskVersion && task.constraintVersion === run.constraintVersion;
      if (!agreement) {
        this.saveRun({ ...run, status: 'cancelled', version: run.version + 1, claimToken: null, errorCode: 'STALE_AGREEMENT', updatedAt: timestamp });
        return undefined;
      }
      if (waiting) return undefined;
      const result = this.result(id);
      if (!result) throw new WorkRuntimeError('MISSING_RESULT', 'Review requires a persisted research result.');
      const claimed = this.saveRun({ ...run, status: 'reviewing', version: run.version + 1, claimToken: randomUUID(), reviewAttempts: run.reviewAttempts + 1, updatedAt: timestamp });
      const controller = new AbortController();
      this.active.set(id, controller);
      return { task, run: claimed, result, signal: controller.signal };
    });
  }
  private storeReview(work: ReviewHandoff, output: WorkReview, deliver: WorkCallbacks['deliver']): boolean {
    if (this.stopping || work.signal.aborted) return false;
    if (output.decision !== 'silent' && output.decision !== 'notify') throw new WorkRuntimeError('INVALID_REVIEW', 'Invalid review decision.');
    const reviewText = text(output.text, 'review.text', 100000);
    return this.transaction(() => {
      if (!this.currentClaim(work, 'reviewing')) return false;
      const task = this.get(work.task.id);
      const timestamp = this.timestamp();
      const review: StoredWorkReview = { id: randomUUID(), resultId: work.result.id, runId: work.run.id, taskId: work.task.id, decision: output.decision, text: reviewText, createdAt: timestamp };
      this.db.prepare('INSERT INTO kw_reviews(id,result_id,run_id,record) VALUES(?,?,?,?)').run(review.id, review.resultId, review.runId, JSON.stringify(review));
      if (oneShotResearch(task)) {
        const existing = this.deliveryForConstraint(task.id, task.constraintVersion);
        if (!existing) {
          if (!deliver) throw new WorkRuntimeError('MISSING_DELIVERY', 'One-shot research has no conversation writer.');
          const evidence = work.result.evidence ?? [];
          if (!evidence.some(item => item.kind === 'url')) throw new WorkRuntimeError('UNSOURCED_RESULT', 'One-shot research requires at least one source URL from web search.');
          const body = formatResearchDelivery(reviewText, evidence);
          const written = deliver({ taskId: task.id, runId: work.run.id, conversationId: task.conversationId, constraintVersion: task.constraintVersion, text: body, evidence });
          const messageId = text(written.messageId, 'delivery.messageId', 192);
          const delivery: WorkDelivery = { id: randomUUID(), taskId: task.id, runId: work.run.id, constraintVersion: task.constraintVersion, conversationId: task.conversationId, messageId, writtenAt: timestamp, readAt: null, text: body, evidence };
          this.db.prepare('INSERT INTO kw_deliveries(id,run_id,task_id,constraint_version,written_at,read_at,record) VALUES(?,?,?,?,?,?,?)').run(delivery.id, delivery.runId, delivery.taskId, delivery.constraintVersion, delivery.writtenAt, null, JSON.stringify(delivery));
        }
      } else if (review.decision === 'notify') this.notify(work.task, work.run, review.text, work.result.id, review.id, timestamp);
      this.saveRun({ ...work.run, status: 'completed', version: work.run.version + 1, claimToken: null, errorCode: null, updatedAt: timestamp });
      if (task.intervalMs === null) this.saveTask({ ...task, status: 'completed', updatedAt: timestamp });
      return true;
    });
  }
  private notify(task: WorkTask, run: WorkRun, message: string, resultId: string | null, reviewId: string | null, timestamp: string): void {
    const notification: WorkNotification = { id: randomUUID(), taskId: task.id, runId: run.id, conversationId: task.conversationId, kind: task.kind, title: task.title, text: message, resultId, reviewId, createdAt: timestamp, readAt: null };
    this.db.prepare('INSERT INTO kw_notifications(id,run_id,task_id,read_at,record) VALUES(?,?,?,?,?)').run(notification.id, run.id, task.id, null, JSON.stringify(notification));
  }
  private failed(work: WorkExecution, stage: 'research' | 'review', error?: unknown): boolean {
    if (this.stopping || work.signal.aborted) return false;
    return this.transaction(() => {
      if (!this.currentClaim(work, stage === 'research' ? 'running' : 'reviewing')) return false;
      const timestamp = this.timestamp();
      if (stage === 'research') {
        const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const uncertain = code !== 'UNSOURCED_RESULT' && /UNKNOWN|TRANSPORT|TIMEOUT|HOST_INTERRUPTED/iu.test(code);
        const status = uncertain ? 'unknown' : 'failed';
        this.saveRun({ ...work.run, status, version: work.run.version + 1, claimToken: null, errorCode: code === 'UNSOURCED_RESULT' ? 'UNSOURCED_RESULT' : uncertain ? 'RESEARCH_OUTCOME_UNKNOWN' : 'RESEARCH_FAILED', updatedAt: timestamp });
        this.saveTask({ ...this.get(work.task.id), status, nextAt: null, updatedAt: timestamp });
      } else {
        const delay = Math.min(3600000, 30000 * 2 ** Math.min(work.run.reviewAttempts - 1, 7));
        this.saveRun({ ...work.run, status: 'review_pending', version: work.run.version + 1, claimToken: null, errorCode: 'REVIEW_FAILED', reviewAfter: new Date(Date.parse(timestamp) + delay).toISOString(), updatedAt: timestamp });
      }
      return true;
    });
  }
  private async executeReview(work: ReviewHandoff, callbacks: WorkCallbacks, counts: WorkTickResult): Promise<void> {
    if (this.stopping || work.signal.aborted) { counts.stale++; this.active.delete(work.run.id); return; }
    try { const output = await callbacks.review(work); if (this.storeReview(work, output, callbacks.deliver)) counts.reviewed++; else counts.stale++; }
    catch (error) { if (this.failed(work, 'review', error)) counts.failed++; else counts.stale++; }
    finally { this.active.delete(work.run.id); }
  }
  private async executeResearch(work: WorkExecution, callbacks: WorkCallbacks, counts: WorkTickResult): Promise<void> {
    if (this.stopping || work.signal.aborted) { counts.stale++; this.active.delete(work.run.id); return; }
    try {
      const output = await callbacks.runResearch(work);
      if (this.storeResult(work, output)) {
        counts.researched++;
        this.active.delete(work.run.id);
        const review = this.claimReview(work.run.id);
        if (review) await this.executeReview(review, callbacks, counts);
      }
      else counts.stale++;
    } catch (error) { if (this.failed(work, 'research', error)) counts.failed++; else counts.stale++; }
    finally { this.active.delete(work.run.id); }
  }
  private track(operation: Promise<void>): Promise<void> {
    this.inFlight.add(operation);
    operation.then(() => this.inFlight.delete(operation), () => this.inFlight.delete(operation));
    return operation;
  }

  /** Called by the product host; each claimed research/review invokes its callback once. */
  async tick(callbacks: WorkCallbacks, options: { limit?: number } = {}): Promise<WorkTickResult> {
    if (this.stopping) throw new WorkRuntimeError('HOST_STOPPING', 'The work host is stopping.');
    const count = limit(options.limit, 4), timestamp = this.timestamp();
    const counts: WorkTickResult = { reminders: 0, researched: 0, reviewed: 0, failed: 0, stale: 0 };
    const reviews: ReviewHandoff[] = [], research: WorkExecution[] = [];
    const previousClaims = new Set(this.active.keys());
    try {
      // Batch admission completes durably before any callback starts.
      this.transaction(() => {
        for (const value of this.db.prepare("SELECT id FROM kw_runs WHERE status='review_pending' AND (json_extract(record,'$.reviewAfter') IS NULL OR json_extract(record,'$.reviewAfter')<=?) ORDER BY rowid LIMIT ?").all(timestamp, count)) {
          if (this.active.size >= this.maxConcurrent) break;
          const work = this.claimReview(String(value.id));
          if (work) reviews.push(work);
        }
        for (const kind of ['reminder', 'research'] as const) {
          if (kind === 'research' && this.active.size >= this.maxConcurrent) continue;
          for (const value of this.db.prepare(`SELECT id FROM kw_tasks WHERE status='active' AND next_at<=? AND json_extract(record,'$.kind')=?
            AND NOT EXISTS (SELECT 1 FROM kw_runs WHERE task_id=kw_tasks.id AND status IN ('running','review_pending','reviewing'))
            ORDER BY next_at,id LIMIT ?`).all(timestamp, kind, count)) {
            if (kind === 'research' && this.active.size >= this.maxConcurrent) break;
            const work = this.claimDue(String(value.id), timestamp);
            if (!work) continue;
            if (kind === 'reminder') counts.reminders++;
            else research.push(work);
          }
        }
      });
    } catch (error) {
      for (const [id, controller] of this.active) if (!previousClaims.has(id)) { controller.abort('work admission failed'); this.active.delete(id); }
      throw error;
    }
    await Promise.all([
      ...reviews.map(work => this.track(Promise.resolve().then(() => this.executeReview(work, callbacks, counts)))),
      ...research.map(work => this.track(Promise.resolve().then(() => this.executeResearch(work, callbacks, counts)))),
    ]);
    return counts;
  }
  notifications(options: { unreadOnly?: boolean; limit?: number } = {}): WorkNotification[] {
    return (options.unreadOnly
      ? this.db.prepare('SELECT record FROM kw_notifications WHERE read_at IS NULL ORDER BY rowid DESC LIMIT ?').all(limit(options.limit))
      : this.db.prepare('SELECT record FROM kw_notifications ORDER BY rowid DESC LIMIT ?').all(limit(options.limit))).map(value => row<WorkNotification>(value)!);
  }
  readNotification(id: string): WorkNotification {
    return this.transaction(() => {
      const value = row<WorkNotification>(this.db.prepare('SELECT record FROM kw_notifications WHERE id=?').get(text(id, 'id', 192)));
      if (!value) throw new WorkRuntimeError('NOT_FOUND', 'Notification not found.');
      if (value.readAt !== null) return value;
      const next = { ...value, readAt: this.timestamp() };
      this.db.prepare('UPDATE kw_notifications SET read_at=?,record=? WHERE id=?').run(next.readAt, JSON.stringify(next), id);
      return next;
    });
  }
  /** Abort local callbacks on host shutdown; startup recovery resolves unfinished claims. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort('work host stopping');
    await Promise.allSettled([...this.inFlight]);
  }
}
