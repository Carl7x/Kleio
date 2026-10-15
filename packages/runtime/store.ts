import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RuntimeError, type ExecutionKind } from './contracts.ts';

export interface Conversation { id: string; title: string; createdAt: string }
export interface Message { id: string; sequence: number; conversationId: string; role: 'user' | 'assistant'; content: string; createdAt: string; executionId: string; status: string }
export interface Execution { id: string; kind: ExecutionKind; conversationId: string | null; messageId: string | null; status: string; text: string; error: string | null; createdAt: string; updatedAt: string }
export interface ProductEvent { sequence: number; executionId: string; type: string; data: Record<string, unknown>; createdAt: string }
type Row = Record<string, unknown>;
const record = <T>(row: Row | undefined): T | undefined => row ? JSON.parse(String(row.record)) as T : undefined;
function terms(value: string): string[] {
  const words = value.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(words.flatMap(word => /^[\p{Script=Han}]+$/u.test(word) && word.length > 1 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))];
}

export class RuntimeStore {
  readonly db: DatabaseSync;
  private deliverySerial = 0;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kr_conversations(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kr_executions(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kr_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES kr_conversations(id), request_id TEXT, execution_id TEXT NOT NULL REFERENCES kr_executions(id), role TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(conversation_id,request_id));
      CREATE TABLE IF NOT EXISTS kr_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS kr_message_conversation ON kr_messages(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS kr_event_execution ON kr_events(execution_id,sequence);
      CREATE TABLE IF NOT EXISTS kr_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kr_commands(id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS kr_message_search USING fts5(message_id UNINDEXED, terms, tokenize='unicode61');
    `);
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  conversations(): Conversation[] { return this.db.prepare('SELECT record FROM kr_conversations ORDER BY rowid DESC').all().map(row => record<Conversation>(row)!); }
  conversation(id: string): Conversation {
    const value = record<Conversation>(this.db.prepare('SELECT record FROM kr_conversations WHERE id=?').get(id));
    if (!value) throw new RuntimeError('not_found', 'Conversation not found', 404); return value;
  }
  createConversation(title = 'New conversation'): Conversation {
    const value = { id: randomUUID(), title, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO kr_conversations VALUES(?,?)').run(value.id, JSON.stringify(value)); return value;
  }
  messages(id: string): Message[] {
    this.conversation(id);
    return this.db.prepare('SELECT sequence,record FROM kr_messages WHERE conversation_id=? ORDER BY sequence').all(id).map(row => ({ ...record<Message>(row)!, sequence: Number(row.sequence) }));
  }
  submit(conversationId: string, content: string, requestId: string): Execution {
    return this.transaction(() => {
      this.conversation(conversationId);
      const previous = record<Message>(this.db.prepare('SELECT record FROM kr_messages WHERE conversation_id=? AND request_id=?').get(conversationId, requestId));
      if (previous) {
        if (previous.content !== content) throw new RuntimeError('request_conflict', 'Request ID already belongs to different content', 409);
        return this.execution(previous.executionId);
      }
      const messageId = randomUUID(); const execution = this.createExecution('conversation', conversationId, messageId);
      const message = { id: messageId, conversationId, role: 'user', content, createdAt: execution.createdAt, executionId: execution.id, status: 'sent' };
      this.db.prepare('INSERT INTO kr_messages(id,conversation_id,request_id,execution_id,role,record) VALUES(?,?,?,?,?,?)').run(messageId, conversationId, requestId, execution.id, 'user', JSON.stringify(message));
      this.db.prepare('INSERT INTO kr_message_search(message_id,terms) VALUES(?,?)').run(messageId, terms(content).join(' '));
      this.event(execution.id, 'message.accepted', { messageId, conversationId }); return execution;
    });
  }
  createExecution(kind: ExecutionKind, conversationId: string | null = null, messageId: string | null = null): Execution {
    const now = new Date().toISOString();
    const execution: Execution = { id: randomUUID(), kind, conversationId, messageId, status: 'queued', text: '', error: null, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO kr_executions VALUES(?,?,?,?)').run(execution.id, kind, execution.status, JSON.stringify(execution)); return execution;
  }
  execution(id: string): Execution {
    const value = record<Execution>(this.db.prepare('SELECT record FROM kr_executions WHERE id=?').get(id));
    if (!value) throw new RuntimeError('not_found', 'Execution not found', 404); return value;
  }
  executions(status?: string): Execution[] {
    return (status ? this.db.prepare('SELECT record FROM kr_executions WHERE status=? ORDER BY rowid').all(status) : this.db.prepare('SELECT record FROM kr_executions ORDER BY rowid DESC LIMIT 100').all()).map(row => record<Execution>(row)!);
  }
  update(id: string, patch: Partial<Execution>): Execution {
    const value = { ...this.execution(id), ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE kr_executions SET status=?,record=? WHERE id=?').run(value.status, JSON.stringify(value), id); return value;
  }
  event(executionId: string, type: string, data: Record<string, unknown> = {}): void {
    this.db.prepare('INSERT INTO kr_events(execution_id,type,data,created_at) VALUES(?,?,?,?)').run(executionId, type, JSON.stringify(data), new Date().toISOString());
  }
  events(after = 0, executionId?: string): ProductEvent[] {
    const rows = executionId ? this.db.prepare('SELECT * FROM kr_events WHERE sequence>? AND execution_id=? ORDER BY sequence LIMIT 500').all(after, executionId) : this.db.prepare('SELECT * FROM kr_events WHERE sequence>? ORDER BY sequence LIMIT 500').all(after);
    return rows.map(row => ({ sequence: Number(row.sequence), executionId: String(row.execution_id), type: String(row.type), data: JSON.parse(String(row.data)), createdAt: String(row.created_at) }));
  }
  /** Inserts one assistant message. A nested savepoint joins the caller's transaction; the same request id does not write a second message. */
  insertAssistantMessage(conversationId: string, content: string, requestId: string): Message {
    if (typeof content !== 'string' || !content.trim() || content.length > 100000) throw new RuntimeError('invalid_input', 'Delivery text is empty', 400);
    if (!requestId || requestId.length > 300) throw new RuntimeError('invalid_input', 'Delivery request id is invalid', 400);
    const name = `kr_delivery_${++this.deliverySerial}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      this.conversation(conversationId);
      const existingRow = this.db.prepare('SELECT sequence, record FROM kr_messages WHERE conversation_id=? AND request_id=?').get(conversationId, requestId) as { sequence: number; record: string } | undefined;
      if (existingRow) {
        const existing = { ...(JSON.parse(existingRow.record) as Message), sequence: Number(existingRow.sequence) };
        this.db.exec(`RELEASE ${name}`);
        return existing;
      }
      const execution = this.createExecution('review', conversationId, null);
      this.update(execution.id, { status: 'completed', text: content });
      const message = { id: randomUUID(), conversationId, role: 'assistant' as const, content, createdAt: new Date().toISOString(), executionId: execution.id, status: 'completed' };
      this.db.prepare('INSERT INTO kr_messages(id,conversation_id,request_id,execution_id,role,record) VALUES(?,?,?,?,?,?)').run(message.id, conversationId, requestId, execution.id, 'assistant', JSON.stringify(message));
      const sequence = Number((this.db.prepare('SELECT sequence FROM kr_messages WHERE id=?').get(message.id) as { sequence: number }).sequence);
      this.db.prepare('INSERT INTO kr_message_search(message_id,terms) VALUES(?,?)').run(message.id, terms(content).join(' '));
      this.db.exec(`RELEASE ${name}`);
      return { ...message, sequence };
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }
  finish(id: string, text: string, status = 'completed', error: string | null = null): Execution {
    return this.transaction(() => {
      const previous = this.execution(id);
      if (!['queued', 'running'].includes(previous.status)) return previous;
      const execution = this.update(id, { status, text, error });
      if (execution.kind === 'conversation' && execution.conversationId) {
        const message = { id: randomUUID(), conversationId: execution.conversationId, role: 'assistant', content: text, createdAt: new Date().toISOString(), executionId: id, status };
        this.db.prepare('INSERT INTO kr_messages(id,conversation_id,execution_id,role,record) VALUES(?,?,?,?,?)').run(message.id, message.conversationId, id, 'assistant', JSON.stringify(message));
        if (status === 'completed') this.db.prepare('INSERT INTO kr_message_search(message_id,terms) VALUES(?,?)').run(message.id, terms(text).join(' '));
      }
      this.event(id, 'execution.' + status, { text, error }); return execution;
    });
  }
  recover(): void {
    for (const execution of this.executions('running')) this.finish(execution.id, execution.text, 'unknown', 'Service stopped before execution settlement; work was not automatically repeated.');
    for (const execution of this.executions('queued')) if (execution.kind !== 'conversation') this.update(execution.id, { status: 'interrupted', error: 'Background owner will decide recovery.' });
  }
  getSetting<T>(key: string, fallback: T): T { const row = this.db.prepare('SELECT value FROM kr_settings WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : fallback; }
  searchMessages(query: string, limit = 12): Message[] {
    const match = terms(query).slice(0, 30).map(word => '"' + word.replaceAll('"', '""') + '"').join(' OR ');
    if (!match) return [];
    return this.db.prepare('SELECT m.sequence,m.record FROM kr_message_search s JOIN kr_messages m ON m.id=s.message_id WHERE kr_message_search MATCH ? ORDER BY rank LIMIT ?').all(match, limit).map(row => ({ ...record<Message>(row)!, sequence: Number(row.sequence) }));
  }
  setSetting(key: string, value: unknown): void { this.db.prepare('INSERT INTO kr_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  command(id: string, value: unknown): void {
    const content = JSON.stringify(value); const row = this.db.prepare('SELECT content FROM kr_commands WHERE id=?').get(id);
    if (row && row.content !== content) throw new RuntimeError('request_conflict', 'Command ID already belongs to different content', 409);
    this.db.prepare('INSERT OR IGNORE INTO kr_commands VALUES(?,?,?)').run(id, content, new Date().toISOString());
  }
  close(): void { this.db.close(); }
}
