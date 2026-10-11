import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { approvalSchema, artifactSchema, conversationSchema, CoreError, eventSchema, memorySchema, messageSchema, runSchema, taskSchema,
  type AgentEvent, type Approval, type Artifact, type Conversation, type Memory, type Message, type MessageSubmission, type Run, type RunStatus, type Task } from './contracts.ts';

const terminal = new Set<RunStatus>(['completed', 'cancelled', 'failed', 'interrupted']);
function now(): string { return new Date().toISOString(); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(Reflect.get(value, key))).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function terms(text: string): Set<string> {
  const clean = text.normalize('NFKC').toLowerCase();
  const result = new Set<string>(clean.match(/[a-z0-9]+/g) ?? []);
  for (const segment of clean.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...segment];
    for (let i = 0; i < chars.length - 1; i++) result.add(chars[i]! + chars[i + 1]!);
    if (chars.length === 1) result.add(chars[0]!);
  }
  return result;
}

/** Single-owner SQLite product state. Startup recovery must run only for the owning service. */
export class AgentStore {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_revisions(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),task_id TEXT NOT NULL REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),role TEXT NOT NULL,client_message_id TEXT,json TEXT NOT NULL,
        UNIQUE(conversation_id,client_message_id));
      CREATE UNIQUE INDEX IF NOT EXISTS artifact_per_run ON artifacts(run_id);
      CREATE INDEX IF NOT EXISTS event_run_sequence ON events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS message_conversation_sequence ON messages(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS message_run_role ON messages(run_id,role);`);
    const existing = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version');
    if (existing && !['1', '2'].includes(String(existing.value))) throw new CoreError('schema_version', '数据库版本不受当前程序支持。', 500);
    // Version 2 only adds conversation tables. Existing version 1 JSON receives null links when read.
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version', '2');
  }
  close(): void { this.db.close(); }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private read<T>(table: 'tasks' | 'runs' | 'memories' | 'approvals' | 'artifacts' | 'conversations' | 'messages', id: string, schema: z.ZodType<T>): T {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id);
    if (!row || typeof row.json !== 'string') throw new CoreError('not_found', '记录不存在。', 404);
    return schema.parse(JSON.parse(row.json));
  }
  private rows<T>(table: 'tasks' | 'runs' | 'memories' | 'approvals' | 'artifacts' | 'conversations', schema: z.ZodType<T>): T[] {
    return this.db.prepare(`SELECT json FROM ${table} ORDER BY rowid DESC`).all().map(row => schema.parse(JSON.parse(z.string().parse(row.json))));
  }
  private write(table: 'tasks' | 'runs' | 'memories' | 'approvals' | 'artifacts' | 'conversations' | 'messages', id: string, value: unknown): void {
    this.db.prepare(`UPDATE ${table} SET json=? WHERE id=?`).run(JSON.stringify(value), id);
  }
  private event(runId: string, type: string, data: Record<string, unknown>): AgentEvent {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO events(run_id,type,data,created_at) VALUES(?,?,?,?)').run(runId, type, JSON.stringify(data), createdAt);
    return { sequence: Number(result.lastInsertRowid), runId, type, data, createdAt };
  }
  tasks(): Task[] { return this.rows('tasks', taskSchema); }
  task(id: string): Task { return this.read('tasks', id, taskSchema); }
  runs(): Run[] { return this.rows('runs', runSchema); }
  run(id: string): Run { return this.read('runs', id, runSchema); }
  conversations(): Conversation[] { return this.rows('conversations', conversationSchema).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  conversation(id: string): Conversation { return this.read('conversations', id, conversationSchema); }
  createConversation(title = '新对话'): Conversation {
    const time = now(); const clean = title.trim() || '新对话';
    const conversation: Conversation = { id: randomUUID(), title: [...clean].slice(0, 100).join(''), activeRunId: null, lastRunId: null, createdAt: time, updatedAt: time };
    this.db.prepare('INSERT INTO conversations(id,json) VALUES(?,?)').run(conversation.id, JSON.stringify(conversation)); return conversation;
  }
  messages(conversationId: string): Message[] {
    this.conversation(conversationId);
    return this.db.prepare('SELECT json FROM messages WHERE conversation_id=? ORDER BY sequence').all(conversationId)
      .map(row => messageSchema.parse(JSON.parse(z.string().parse(row.json))));
  }
  private insertMessage(input: Omit<Message, 'id' | 'sequence' | 'createdAt' | 'updatedAt'>, clientMessageId: string | null = null): Message {
    const time = now(); const message: Message = { ...input, id: randomUUID(), sequence: 0, createdAt: time, updatedAt: time };
    const result = this.db.prepare('INSERT INTO messages(id,conversation_id,task_id,run_id,role,client_message_id,json) VALUES(?,?,?,?,?,?,?)')
      .run(message.id, message.conversationId, message.taskId, message.runId, message.role, clientMessageId, JSON.stringify(message));
    message.sequence = Number(result.lastInsertRowid); this.write('messages', message.id, message); return message;
  }
  private assistantMessage(runId: string): Message | null {
    const row = this.db.prepare("SELECT json FROM messages WHERE run_id=? AND role='assistant'").get(runId);
    return row ? messageSchema.parse(JSON.parse(z.string().parse(row.json))) : null;
  }
  /** Duplicate network submissions replay their original identity without executing a second time. */
  submitMessage(conversationId: string, prompt: string, clientMessageId: string, engine: string): MessageSubmission {
    const text = prompt.trim();
    if (!text) throw new CoreError('empty_prompt', '请填写消息。', 400);
    if (!clientMessageId.trim() || clientMessageId.length > 128) throw new CoreError('message_id', '消息需要稳定的提交标识。', 400);
    return this.transaction(() => {
      const conversation = this.conversation(conversationId);
      const existing = this.db.prepare('SELECT json FROM messages WHERE conversation_id=? AND client_message_id=?').get(conversationId, clientMessageId);
      if (existing) {
        const message = messageSchema.parse(JSON.parse(z.string().parse(existing.json)));
        if (message.content !== text) throw new CoreError('message_conflict', '同一提交标识已经用于另一条消息。');
        if (!message.runId) throw new CoreError('message_incomplete', '消息缺少执行记录。', 500);
        return { conversationId, messageId: message.id, taskId: message.taskId, runId: message.runId, replayed: true };
      }
      if (conversation.activeRunId) throw new CoreError('conversation_busy', '助理正在处理本轮消息，请等待完成或先停止。');
      const task = this.createTaskRecord(text, conversationId);
      const message = this.insertMessage({ conversationId, role: 'user', content: text, taskId: task.id, runId: null, status: 'sent', error: null }, clientMessageId);
      const run = this.startRunRecord(task.id, engine);
      this.write('messages', message.id, { ...message, runId: run.id });
      this.db.prepare('UPDATE messages SET run_id=? WHERE id=?').run(run.id, message.id);
      const current = this.conversation(conversationId);
      if (conversation.lastRunId === null && conversation.title === '新对话') this.write('conversations', conversationId, { ...current, title: task.title });
      this.event(run.id, 'message.created', { conversationId, messageId: message.id });
      return { conversationId, messageId: message.id, taskId: task.id, runId: run.id, replayed: false };
    });
  }
  createTask(prompt: string): Task {
    return this.createTaskRecord(prompt, null);
  }
  private createTaskRecord(prompt: string, conversationId: string | null): Task {
    const text = prompt.trim();
    if (!text) throw new CoreError('empty_prompt', '请填写任务。', 400);
    const time = now();
    const task: Task = { id: randomUUID(), title: [...text].slice(0, 50).join(''), prompt: text, status: 'queued', conversationId, currentRunId: null, createdAt: time, updatedAt: time };
    this.db.prepare('INSERT INTO tasks(id,json) VALUES(?,?)').run(task.id, JSON.stringify(task)); return task;
  }
  startRun(taskId: string, engine: string): Run {
    return this.transaction(() => this.startRunRecord(taskId, engine));
  }
  private startRunRecord(taskId: string, engine: string): Run {
      const task = this.task(taskId);
      if (task.currentRunId && !terminal.has(this.run(task.currentRunId).status)) throw new CoreError('already_running', '任务正在执行，请先停止。');
      if (task.currentRunId && this.run(task.currentRunId).status === 'completed') throw new CoreError('already_completed', '已完成任务；请创建后续任务。');
      const conversation = task.conversationId ? this.conversation(task.conversationId) : null;
      if (conversation?.activeRunId) throw new CoreError('conversation_busy', '助理正在处理本轮消息，请等待完成或先停止。');
      const latest = conversation?.lastRunId ? this.run(conversation.lastRunId) : null;
      if (task.currentRunId && latest && latest.taskId !== taskId) throw new CoreError('conversation_advanced', '对话已有后续消息，请在最新上下文中重新提出请求。');
      const time = now(); const previous = conversation ? latest : task.currentRunId ? this.run(task.currentRunId) : null;
      const run: Run = { id: randomUUID(), taskId, conversationId: task.conversationId, engine, status: 'running', sessionId: previous?.engine === engine ? previous.sessionId : null,
        error: null, createdAt: time, updatedAt: time };
      this.db.prepare('INSERT INTO runs(id,task_id,json) VALUES(?,?,?)').run(run.id, taskId, JSON.stringify(run));
      this.write('tasks', task.id, { ...task, status: 'running', currentRunId: run.id, updatedAt: time });
      if (conversation) {
        this.write('conversations', conversation.id, { ...conversation, activeRunId: run.id, lastRunId: run.id, updatedAt: time });
        this.insertMessage({ conversationId: conversation.id, role: 'assistant', content: '', taskId, runId: run.id, status: 'running', error: null });
      }
      this.event(run.id, 'run.started', { taskId, engine, conversationId: task.conversationId }); return run;
  }
  private active(id: string): Run {
    const run = this.run(id);
    if (terminal.has(run.status)) throw new CoreError('run_settled', '任务已经结束，不接受迟到的结果。');
    return run;
  }
  private status(run: Run, status: RunStatus, error: string | null = null): void {
    const time = now(); const task = this.task(run.taskId);
    if (task.currentRunId !== run.id) throw new CoreError('run_replaced', '该轮执行已被替代。');
    this.write('runs', run.id, { ...run, status, error, updatedAt: time });
    this.write('tasks', task.id, { ...task, status, updatedAt: time });
    if (run.conversationId) {
      const conversation = this.conversation(run.conversationId);
      if (conversation.activeRunId !== run.id) throw new CoreError('run_replaced', '该轮对话执行已被替代。');
      this.write('conversations', conversation.id, { ...conversation, activeRunId: terminal.has(status) ? null : run.id, lastRunId: run.id, updatedAt: time });
      const message = this.assistantMessage(run.id);
      if (message) this.write('messages', message.id, { ...message, status, error, updatedAt: time });
    }
  }
  appendText(id: string, text: string): void {
    this.transaction(() => {
      this.active(id); const message = this.assistantMessage(id);
      if (message) this.write('messages', message.id, { ...message, content: message.content + text, updatedAt: now() });
      this.event(id, 'assistant.text', { text });
    });
  }
  setSession(id: string, sessionId: string): void {
    this.transaction(() => { const run = this.active(id); this.write('runs', id, { ...run, sessionId, updatedAt: now() }); this.event(id, 'session.bound', { sessionId }); });
  }
  complete(id: string, text: string): Artifact {
    return this.transaction(() => {
      const run = this.active(id);
      if (run.status !== 'running') throw new CoreError('approval_pending', '审批尚未完成，不能交付结果。');
      const artifact: Artifact = { id: randomUUID(), runId: id, title: this.task(run.taskId).title, content: text, mediaType: 'text/markdown', createdAt: now() };
      this.db.prepare('INSERT INTO artifacts(id,run_id,json) VALUES(?,?,?)').run(artifact.id, id, JSON.stringify(artifact));
      const message = this.assistantMessage(id);
      if (message) this.write('messages', message.id, { ...message, content: text, updatedAt: now() });
      this.status(run, 'completed'); this.event(id, 'artifact.created', { artifactId: artifact.id }); this.event(id, 'run.completed', { artifactId: artifact.id });
      return artifact;
    });
  }
  settle(id: string, status: 'cancelled' | 'failed' | 'interrupted', error: string | null, options: { discardSession?: boolean } = {}): void {
    this.transaction(() => {
      const run = this.active(id); this.status(options.discardSession ? { ...run, sessionId: null } : run, status, error);
      for (const approval of this.approvals().filter(a => a.runId === id && a.status === 'pending')) this.write('approvals', approval.id, { ...approval, status: 'interrupted' });
      this.event(id, 'run.' + status, { error, ...(options.discardSession ? { invalidatedSessionId: run.sessionId } : {}) });
    });
  }
  requestCancel(id: string): void {
    this.transaction(() => {
      const run = this.active(id);
      if (run.status === 'cancelling') return;
      this.status(run, 'cancelling');
      for (const approval of this.approvals().filter(a => a.runId === id && a.status === 'pending')) this.write('approvals', approval.id, { ...approval, status: 'interrupted' });
      this.event(id, 'run.cancelling', {});
    });
  }
  /** Interrupted work requires explicit restart; no external side effect is automatically retried. */
  recoverInterrupted(): number {
    const active = this.runs().filter(run => !terminal.has(run.status));
    for (const run of active) this.settle(run.id, 'interrupted', '执行进程已退出。请检查已有结果，再决定是否继续。', { discardSession: run.conversationId !== null });
    return active.length;
  }
  events(runId: string, after = 0): AgentEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence').all(runId, after).map(row => eventSchema.parse({
      sequence: row.sequence, runId: row.run_id, type: row.type, data: JSON.parse(z.string().parse(row.data)), createdAt: row.created_at }));
  }
  /** Application history is stored in full, but context supplied to an engine is bounded. */
  historyForRun(runId: string): Array<Pick<Message, 'role' | 'content'>> {
    const run = this.run(runId);
    if (!run.conversationId) return [];
    const current = this.assistantMessage(runId);
    let remaining = 16_000;
    return this.messages(run.conversationId)
      .filter(message => message.taskId !== run.taskId && (!current || message.sequence < current.sequence) &&
        (message.role === 'user' || message.status === 'completed'))
      .slice(-12).reverse().flatMap(message => {
        if (remaining <= 0) return [];
        const content = message.content.slice(-remaining); remaining -= content.length;
        return [{ role: message.role, content }];
      }).reverse();
  }
  approvals(): Approval[] { return this.rows('approvals', approvalSchema); }
  propose(id: string, kind: string, payload: Record<string, unknown>, lifetimeMs = 300_000): Approval {
    return this.transaction(() => {
      const run = this.active(id);
      if (run.status === 'waiting_approval') throw new CoreError('approval_pending', '当前已有待处理审批。');
      const approval: Approval = { id: randomUUID(), runId: id, kind, payload, hash: hash({ runId: id, kind, payload }), status: 'pending',
        createdAt: now(), expiresAt: new Date(Date.now() + lifetimeMs).toISOString() };
      this.db.prepare('INSERT INTO approvals(id,run_id,json) VALUES(?,?,?)').run(approval.id, id, JSON.stringify(approval));
      this.status(run, 'waiting_approval'); this.event(id, 'approval.requested', { approvalId: approval.id, kind }); return approval;
    });
  }
  decide(id: string, expectedHash: string, allowed: boolean): Approval {
    return this.transaction(() => {
      const approval = this.read('approvals', id, approvalSchema);
      if (approval.hash !== expectedHash) throw new CoreError('stale_approval', '审批内容已变化，请重新查看。');
      if (approval.status !== 'pending') throw new CoreError('approval_settled', '这条审批已经处理。');
      const run = this.active(approval.runId);
      const expired = Date.parse(approval.expiresAt) <= Date.now();
      const status = expired ? 'expired' : allowed ? 'approved' : 'rejected';
      const decided: Approval = { ...approval, status };
      this.write('approvals', id, decided); this.status(run, 'running');
      this.event(run.id, 'approval.' + status, { approvalId: id }); return decided;
    });
  }
  artifacts(): Artifact[] { return this.rows('artifacts', artifactSchema); }
  memories(includeDeleted = false): Memory[] { return this.rows('memories', memorySchema).filter(memory => includeDeleted || !memory.deleted); }
  private revision(memory: Memory, reason: string): void {
    this.write('memories', memory.id, memory);
    this.db.prepare('INSERT INTO memory_revisions(id,version,json,reason) VALUES(?,?,?,?)').run(memory.id, memory.version, JSON.stringify(memory), reason);
  }
  addMemory(text: string, source: string, scope = 'personal', kind: Memory['kind'] = 'explicit'): Memory {
    if (!text.trim() || !source.trim()) throw new CoreError('memory_source', '记忆需要内容和来源。', 400);
    const memory: Memory = { id: randomUUID(), text: text.trim(), source, scope, kind, version: 1, pinned: false, deleted: false, updatedAt: now() };
    return this.transaction(() => { this.db.prepare('INSERT INTO memories(id,json) VALUES(?,?)').run(memory.id, JSON.stringify(memory)); this.revision(memory, 'create'); return memory; });
  }
  editMemory(id: string, version: number, text: string, source: string): Memory {
    return this.transaction(() => {
      const memory = this.read('memories', id, memorySchema);
      if (memory.version !== version) throw new CoreError('memory_conflict', '记忆已经更新，请先读取最新版本。');
      if (!text.trim() || !source.trim()) throw new CoreError('memory_source', '记忆需要内容和来源。', 400);
      const next: Memory = { ...memory, text: text.trim(), source, version: version + 1, updatedAt: now() };
      this.revision(next, 'edit'); return next;
    });
  }
  deleteMemory(id: string, version: number): Memory {
    return this.transaction(() => {
      const memory = this.read('memories', id, memorySchema);
      if (memory.version !== version) throw new CoreError('memory_conflict', '记忆已经更新，请先读取最新版本。');
      const next: Memory = { ...memory, deleted: true, version: version + 1, updatedAt: now() };
      this.revision(next, 'delete'); return next;
    });
  }
  undoMemory(id: string, version: number): Memory {
    return this.transaction(() => {
      const memory = this.read('memories', id, memorySchema);
      if (memory.version !== version) throw new CoreError('memory_conflict', '记忆已经更新，请先读取最新版本。');
      const row = this.db.prepare('SELECT json FROM memory_revisions WHERE id=? AND version=?').get(id, version - 1);
      if (!row) throw new CoreError('no_revision', '没有可撤销的版本。');
      const previous = memorySchema.parse(JSON.parse(z.string().parse(row.json)));
      const next = { ...previous, version: version + 1, updatedAt: now() }; this.revision(next, 'undo'); return next;
    });
  }
  memoryHistory(id: string): Array<{ memory: Memory; reason: string }> {
    return this.db.prepare('SELECT json,reason FROM memory_revisions WHERE id=? ORDER BY version').all(id).map(row => ({
      memory: memorySchema.parse(JSON.parse(z.string().parse(row.json))), reason: z.string().parse(row.reason) }));
  }
  /** Lexical Chinese bigrams; not semantic retrieval or automatic fact consolidation. */
  recall(query: string, scope = 'personal', limit = 6): Memory[] {
    const wanted = terms(query);
    return this.memories().filter(memory => memory.scope === scope).map(memory => {
      const available = terms(memory.text); const score = [...wanted].filter(term => available.has(term)).length;
      return { memory, score: memory.pinned ? score + 100 : score };
    }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(entry => entry.memory);
  }
}
