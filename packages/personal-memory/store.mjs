/** Application-owned personal memory. Native SQLite; no external memory process. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class MemoryError extends Error {
  constructor(code, message) { super(message); this.name = 'MemoryError'; this.code = code; }
}

function text(value, field, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new MemoryError('INVALID_INPUT', `${field} must be a nonempty string of at most ${max} characters.`);
  }
  return value.trim();
}
function canonical(value) { return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim(); }
function sourceOf(source) {
  if (!source || typeof source !== 'object') throw new MemoryError('SOURCE_REQUIRED', 'A trusted conversation source is required.');
  return { sessionId: text(source.sessionId, 'sessionId', 192), turnId: text(source.turnId, 'turnId', 192),
    ...(source.messageId ? { messageId: text(source.messageId, 'messageId', 192) } : {}),
    ...(source.kind ? { kind: text(source.kind, 'source.kind', 40) } : {}),
    ...(source.label ? { label: text(source.label, 'source.label', 200) } : {}) };
}
/** Explicit CJK bigrams make FTS useful for Chinese without an embedding provider. */
function tokens(value, includeSingleCharacters = false) {
  const terms = new Set();
  for (const segment of canonical(value).split(/([\p{Script=Han}]+)/u)) {
    if (!segment) continue;
    const parts = /^[\p{Script=Han}]+$/u.test(segment) ? [segment] : (segment.match(/[\p{L}\p{N}_-]+/gu) || []);
    for (const part of parts) {
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      const characters = [...part];
      if (characters.length === 1) terms.add(part);
      else for (let index = 0; index + 1 < characters.length; index++) terms.add(characters[index] + characters[index + 1]);
      if (includeSingleCharacters) for (const character of characters) terms.add(character);
    } else terms.add(part);
    }
  }
  return [...terms];
}
function boundedLimit(value, max = 100) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new MemoryError('INVALID_INPUT', `limit must be between 1 and ${max}.`);
  return value;
}

export class MemoryStore {
  constructor(file) {
    this.listeners = new Set();
    this.pendingChanges = [];
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS personal_memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, subject_key TEXT NOT NULL, fact_key TEXT NOT NULL,
        version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, record TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_memory_slot ON personal_memories(scope, subject_key, fact_key) WHERE deleted=0;
      CREATE TABLE IF NOT EXISTS personal_memory_revisions (
        id TEXT NOT NULL REFERENCES personal_memories(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, operation TEXT NOT NULL, record TEXT NOT NULL,
        source TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(id, version)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS personal_memory_search USING fts5(id UNINDEXED, terms, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS personal_memory_imports (import_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_memory_review_receipts(candidate_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,record TEXT NOT NULL,review_action_id TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }
  close() { this.db.close(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  findSlot({ subject, key, scope = 'personal', includeDeleted = false }) {
    const row = this.db.prepare(`SELECT record FROM personal_memories WHERE scope=? AND subject_key=? AND fact_key=? ${includeDeleted ? '' : 'AND deleted=0'} ORDER BY deleted ASC,rowid DESC LIMIT 1`)
      .get(text(scope, 'scope', 80), canonical(text(subject, 'subject', 80)), canonical(text(key, 'key', 80)));
    return row ? JSON.parse(row.record) : null;
  }
  hasForgottenSlot({ subject, key, scope = 'personal' }) {
    return Boolean(this.db.prepare('SELECT 1 FROM personal_memories WHERE scope=? AND subject_key=? AND fact_key=? AND deleted=1')
      .get(scope, canonical(subject), canonical(key)));
  }
  reviewReceipt(id) {
    const row = this.db.prepare('SELECT record,review_action_id FROM personal_memory_review_receipts WHERE candidate_id=?').get(id);
    return row ? { record: JSON.parse(row.record), reviewActionId: row.review_action_id } : null;
  }
  /** One facts-side transaction and receipt make review retry-safe across the application DB boundary. */
  acceptReviewedCandidate(input, source, reviewActionId) {
    const provenance = sourceOf(source), candidateId = text(input.id, 'candidateId', 192);
    const subject = text(input.subject, 'subject', 80), key = text(input.key, 'key', 80), content = text(input.text, 'text');
    const requestHash = createHash('sha256').update(JSON.stringify({ subject, key, content, mode: input.mode, memoryId: input.memoryId, memoryVersion: input.memoryVersion, provenance })).digest('hex');
    return this.transaction(() => {
      const receipt = this.db.prepare('SELECT request_hash,record,review_action_id FROM personal_memory_review_receipts WHERE candidate_id=?').get(candidateId);
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new MemoryError('REVIEW_CONFLICT', 'This candidate already has a different review decision.');
        return { record: JSON.parse(receipt.record), reviewActionId: receipt.review_action_id };
      }
      if (this.hasForgottenSlot({ subject, key })) throw new MemoryError('FORGOTTEN_FACT', 'This fact was forgotten; use an explicit restore instead of accepting an old candidate.');
      const existing = this.findSlot({ subject, key });
      let record;
      if (input.mode === 'correct') {
        if (!existing || existing.id !== input.memoryId) throw new MemoryError('MEMORY_CONFLICT', 'Review the current record in this fact slot.');
        this.version(existing, input.memoryVersion);
        record = existing.text === content ? existing : this.persist({ ...existing, text: content, kind: 'explicit', version: existing.version + 1,
          updatedAt: new Date().toISOString(), source: provenance, reviewActionId }, 'review-correct', provenance);
      } else if (input.mode === 'create') {
        if (existing && existing.text !== content) throw new MemoryError('MEMORY_CONFLICT', 'An active fact occupies this slot; explicitly review its current version.');
        const now = new Date().toISOString();
        record = existing || this.persist({ id: randomUUID(), subject, key, text: content, scope: 'personal', kind: 'explicit', version: 1, deleted: false,
          createdAt: now, updatedAt: now, source: provenance, reviewActionId }, 'review-remember', provenance);
      } else throw new MemoryError('INVALID_INPUT', 'Choose create or correct.');
      this.db.prepare('INSERT INTO personal_memory_review_receipts(candidate_id,request_hash,record,review_action_id) VALUES(?,?,?,?)')
        .run(candidateId, requestHash, JSON.stringify(record), text(reviewActionId, 'reviewActionId', 192));
      return { record, reviewActionId };
    });
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    this.pendingChanges = [];
    let result;
    try { result = action(); this.db.exec('COMMIT'); }
    catch (error) { this.pendingChanges = []; this.db.exec('ROLLBACK'); throw error; }
    const changes = this.pendingChanges; this.pendingChanges = [];
    for (const listener of this.listeners) {
      try { listener(changes); this.projectionError = undefined; }
      catch { this.projectionError = 'MEMORY_FILE_SYNC_FAILED'; }
    }
    return result;
  }
  get(id) {
    const row = this.db.prepare('SELECT record FROM personal_memories WHERE id=?').get(text(id, 'id', 192));
    if (!row) throw new MemoryError('NOT_FOUND', 'Memory was not found.');
    return JSON.parse(row.record);
  }
  version(record, expected) {
    if (!Number.isInteger(expected) || expected !== record.version) throw new MemoryError('STALE_VERSION', 'Read the latest memory before changing it.');
  }
  persist(record, operation, source) {
    this.db.prepare(`INSERT INTO personal_memories(id,scope,subject_key,fact_key,version,deleted,record) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,subject_key=excluded.subject_key,fact_key=excluded.fact_key,
      version=excluded.version,deleted=excluded.deleted,record=excluded.record`)
      .run(record.id, record.scope, canonical(record.subject), canonical(record.key), record.version, Number(record.deleted), JSON.stringify(record));
    this.db.prepare('INSERT INTO personal_memory_revisions(id,version,operation,record,source,created_at) VALUES(?,?,?,?,?,?)')
      .run(record.id, record.version, operation, JSON.stringify(record), JSON.stringify(source), record.updatedAt);
    this.db.prepare('DELETE FROM personal_memory_search WHERE id=?').run(record.id);
    if (!record.deleted) this.db.prepare('INSERT INTO personal_memory_search(id,terms) VALUES(?,?)')
      .run(record.id, tokens(`${record.subject} ${record.key} ${record.text}`, true).join(' '));
    this.pendingChanges.push({ record, operation });
    return record;
  }
  remember(input, source) {
    const provenance = sourceOf(source);
    const subject = text(input.subject, 'subject', 80), key = text(input.key, 'key', 80);
    const content = text(input.text, 'text'), scope = text(input.scope || 'personal', 'scope', 80);
    const kind = input.kind || 'explicit';
    if (!['explicit', 'inferred', 'observation', 'imported'].includes(kind)) throw new MemoryError('INVALID_INPUT', 'Invalid memory kind.');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT record FROM personal_memories WHERE scope=? AND subject_key=? AND fact_key=? AND deleted=0')
        .get(scope, canonical(subject), canonical(key));
      if (existing) {
        const current = JSON.parse(existing.record);
        if (current.text === content) return current;
        throw new MemoryError('MEMORY_CONFLICT', 'This subject already has this fact. Recall it, then explicitly correct its current version.');
      }
      if (kind !== 'explicit' && this.db.prepare('SELECT 1 FROM personal_memories WHERE scope=? AND subject_key=? AND fact_key=? AND deleted=1')
        .get(scope, canonical(subject), canonical(key))) throw new MemoryError('FORGOTTEN_FACT', 'An inferred fact cannot silently recreate a forgotten fact slot.');
      const timestamp = new Date().toISOString();
      return this.persist({ id: randomUUID(), subject, key, text: content, scope, kind, version: 1, deleted: false,
        createdAt: timestamp, updatedAt: timestamp, source: provenance }, 'remember', provenance);
    });
  }
  correct({ id, expectedVersion, text: content }, source) {
    const provenance = sourceOf(source), clean = text(content, 'text');
    return this.transaction(() => {
      const current = this.get(id); this.version(current, expectedVersion);
      if (current.deleted) throw new MemoryError('DELETED_MEMORY', 'Restore the memory before correcting it.');
      if (current.text === clean) return current;
      return this.persist({ ...current, text: clean, version: current.version + 1, updatedAt: new Date().toISOString(), source: provenance }, 'correct', provenance);
    });
  }
  /** Recoverable deletion: excluded from all recall, retained in the revision journal. */
  forget({ id, expectedVersion }, source) {
    const provenance = sourceOf(source);
    return this.transaction(() => {
      const current = this.get(id); this.version(current, expectedVersion);
      if (current.deleted) return current;
      return this.persist({ ...current, deleted: true, version: current.version + 1, updatedAt: new Date().toISOString(), source: provenance }, 'forget', provenance);
    });
  }
  history(id) {
    this.get(id);
    return this.db.prepare('SELECT version,operation,record,source,created_at FROM personal_memory_revisions WHERE id=? ORDER BY version').all(id)
      .map(row => ({ version: row.version, operation: row.operation, record: JSON.parse(row.record), source: JSON.parse(row.source), createdAt: row.created_at }));
  }
  restore({ id, expectedVersion, targetVersion }, source) {
    const provenance = sourceOf(source);
    return this.transaction(() => {
      const current = this.get(id); this.version(current, expectedVersion);
      if (!Number.isInteger(targetVersion) || targetVersion < 1 || targetVersion >= current.version) throw new MemoryError('INVALID_INPUT', 'Select a prior revision to restore.');
      const previous = this.db.prepare('SELECT record FROM personal_memory_revisions WHERE id=? AND version=?').get(id, targetVersion);
      if (!previous) throw new MemoryError('NOT_FOUND', 'Revision was not found.');
      const old = JSON.parse(previous.record);
      const collision = !old.deleted && this.db.prepare('SELECT id FROM personal_memories WHERE scope=? AND subject_key=? AND fact_key=? AND deleted=0 AND id<>?')
        .get(old.scope, canonical(old.subject), canonical(old.key), id);
      if (collision) throw new MemoryError('MEMORY_CONFLICT', 'An active replacement occupies this fact; correct or remove it before restoring.');
      return this.persist({ ...old, version: current.version + 1, updatedAt: new Date().toISOString(), source: provenance }, 'restore', provenance);
    });
  }
  list({ scope = 'personal', includeDeleted = false, limit = 100, query = '' } = {}) {
    if (typeof query !== 'string' || query.length > 500) throw new MemoryError('INVALID_INPUT', 'query must be at most 500 characters.');
    const clean = query.trim();
    return this.db.prepare(`SELECT record FROM personal_memories WHERE scope=? ${includeDeleted ? '' : 'AND deleted=0'}
      ${clean ? "AND instr(lower(json_extract(record,'$.subject') || ' ' || json_extract(record,'$.key') || ' ' || json_extract(record,'$.text')),lower(?))>0" : ''}
      ORDER BY rowid DESC LIMIT ?`)
      .all(text(scope, 'scope', 80), ...(clean ? [clean] : []), boundedLimit(limit)).map(row => JSON.parse(row.record));
  }
  search({ query, scope = 'personal', limit = 8 }) {
    const clean = text(query, 'query', 500), selected = text(scope, 'scope', 80), count = boundedLimit(limit, 20);
    const terms = canonical(clean).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const haystack = "lower(json_extract(record,'$.subject') || ' ' || json_extract(record,'$.key') || ' ' || json_extract(record,'$.text'))";
    const matches = this.db.prepare(`SELECT record FROM personal_memories WHERE scope=? AND deleted=0
      AND ${terms.map(() => `instr(${haystack},?)>0`).join(' AND ')} ORDER BY rowid DESC LIMIT 60`)
      .all(selected, ...terms).map(row => JSON.parse(row.record));
    // Phrase matches take priority; word matching does not imply semantic similarity.
    const normalized = canonical(clean);
    return matches.sort((a, b) => Number(canonical(`${b.subject} ${b.key} ${b.text}`).includes(normalized)) - Number(canonical(`${a.subject} ${a.key} ${a.text}`).includes(normalized)))
      .slice(0, count);
  }
  /** Idempotent old-data import. The original JSONL file remains untouched. */
  importReferenceGraph(lines, importKey) {
    const key = text(importKey, 'importKey', 200);
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM personal_memory_imports WHERE import_key=?').get(key)) return { imported: 0, alreadyImported: true };
      let imported = 0;
      for (const [lineIndex, raw] of lines.entries()) {
        if (!raw.trim()) continue;
        const entity = JSON.parse(raw);
        if (entity.type !== 'entity') continue;
        const subject = text(entity.name, 'subject', 80);
        if (!Array.isArray(entity.observations)) throw new MemoryError('INVALID_IMPORT', 'Invalid observations in reference graph.');
        for (const [observationIndex, observation] of entity.observations.entries()) {
          const timestamp = new Date().toISOString();
          const source = { sessionId: 'legacy-reference-import', turnId: `${lineIndex + 1}:${observationIndex + 1}` };
          this.persist({ id: randomUUID(), subject, key: `导入观察-${lineIndex + 1}-${observationIndex + 1}`, text: text(observation, 'text'), scope: 'personal', kind: 'imported',
            version: 1, deleted: false, createdAt: timestamp, updatedAt: timestamp, source }, 'import', source);
          imported++;
        }
      }
      this.db.prepare('INSERT INTO personal_memory_imports(import_key,created_at) VALUES(?,?)').run(key, new Date().toISOString());
      return { imported, alreadyImported: false };
    });
  }
}
