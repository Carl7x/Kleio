import { createHash, randomUUID } from 'node:crypto';
import { atomic, auditAction } from './profile.mjs';
import { boundedText, slotPart, requireSafeFact, PersonalDataError } from './safety.mjs';

const slotFor = ({ subject, key }) => JSON.stringify([slotPart(subject), slotPart(key)]);
const fingerprintFor = fact => createHash('sha256').update(JSON.stringify([slotFor(fact), fact.text.trim()])).digest('hex');
const limitOf = value => {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new PersonalDataError('INVALID_LIMIT', 'Choose a limit between 1 and 100.');
  return value;
};
function trustedSource(value) {
  return { sessionId: boundedText(value?.sessionId, 'sessionId', 192), turnId: boundedText(value?.turnId, 'turnId', 192),
    messageId: boundedText(value?.messageId, 'messageId', 192) };
}

/** Proposed facts are application data, and never enter retrieval before explicit review. */
export class CandidateStore {
  constructor(db, memory) {
    this.db = db; this.memory = memory;
    db.exec(`CREATE TABLE IF NOT EXISTS personal_memory_candidates(
      id TEXT PRIMARY KEY,version INTEGER NOT NULL,status TEXT NOT NULL,slot_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,record TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS personal_candidate_status ON personal_memory_candidates(status,created_at);
      CREATE TABLE IF NOT EXISTS personal_memory_candidate_blocks(slot_key TEXT PRIMARY KEY,action_id TEXT NOT NULL,created_at TEXT NOT NULL);`);
  }
  get(id) {
    const row = this.db.prepare('SELECT record FROM personal_memory_candidates WHERE id=?').get(boundedText(id, 'id', 192));
    if (!row) throw new PersonalDataError('NOT_FOUND', 'Candidate was not found.');
    return JSON.parse(row.record);
  }
  save(record) {
    this.db.prepare(`INSERT INTO personal_memory_candidates(id,version,status,slot_key,fingerprint,record,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,status=excluded.status,record=excluded.record`)
      .run(record.id, record.version, record.status, slotFor(record), fingerprintFor(record), JSON.stringify(record), record.createdAt);
    return record;
  }
  blocked(fact) {
    return Boolean(this.db.prepare('SELECT 1 FROM personal_memory_candidate_blocks WHERE slot_key=?').get(slotFor(fact)))
      || this.memory.hasForgottenSlot(fact);
  }
  add(input, source) {
    const fact = { subject: boundedText(input.subject, 'subject', 80), key: boundedText(input.key, 'key', 80),
      text: boundedText(input.text, 'text', 1000) };
    requireSafeFact(fact);
    const quote = boundedText(input.sourceQuote, 'sourceQuote', 500);
    const provenance = trustedSource(source);
    return atomic(this.db, () => {
      if (this.blocked(fact)) return null;
      const current = this.memory.findSlot(fact);
      if (current?.text === fact.text) return null;
      if (this.db.prepare('SELECT 1 FROM personal_memory_candidates WHERE fingerprint=?').get(fingerprintFor(fact))) return null;
      const now = new Date().toISOString();
      return this.save({ id: randomUUID(), ...fact, version: 1, status: 'pending', source: provenance,
        sourceQuote: quote, createdAt: now, updatedAt: now,
        ...(current ? { conflict: { id: current.id, version: current.version, text: current.text } } : {}) });
    });
  }
  /** Repair only a facts-side committed receipt; never re-execute an unknown model or tool request. */
  reconcile(record) {
    if (record.status !== 'pending') return record;
    const receipt = this.memory.reviewReceipt(record.id);
    if (receipt) {
      this.db.prepare('INSERT OR IGNORE INTO app_actions(id,kind,details,created_at) VALUES(?,?,?,?)')
        .run(receipt.reviewActionId, 'candidate.accept', JSON.stringify({ candidateId: record.id, recoveredReceipt: true }), receipt.record.updatedAt);
      return this.save({ ...record, status: 'accepted', version: record.version + 1, memoryId: receipt.record.id,
        reviewActionId: receipt.reviewActionId, updatedAt: new Date().toISOString() });
    }
    if (this.blocked(record)) return this.save({ ...record, status: 'rejected', version: record.version + 1,
      rejectionReason: 'blocked_or_forgotten', updatedAt: new Date().toISOString() });
    return record;
  }
  view(record) {
    const { conflict: ignored, ...result } = record;
    if (record.status !== 'pending') return result;
    const current = this.memory.findSlot(record);
    return { ...result, ...(current && current.text !== record.text ? { conflict: { id: current.id, version: current.version, text: current.text } } : {}) };
  }
  list({ status = 'pending', limit = 50 } = {}) {
    if (!['pending', 'accepted', 'rejected', 'all'].includes(status)) throw new PersonalDataError('INVALID_INPUT', 'Choose a candidate status.');
    const count = limitOf(limit);
    // Pending records may have been reviewed just before an interrupted application commit.
    atomic(this.db, () => {
      for (const row of this.db.prepare("SELECT record FROM personal_memory_candidates WHERE status='pending'").all()) this.reconcile(JSON.parse(row.record));
    });
    return this.db.prepare(`SELECT record FROM personal_memory_candidates ${status === 'all' ? '' : 'WHERE status=?'} ORDER BY created_at DESC,rowid DESC LIMIT ?`)
      .all(...(status === 'all' ? [count] : [status, count])).map(row => this.view(JSON.parse(row.record)));
  }
  accept(input) {
    return atomic(this.db, () => {
      const record = this.get(input.id);
      const receipt = this.memory.reviewReceipt(record.id);
      if (record.status === 'rejected') throw new PersonalDataError('CANDIDATE_REJECTED', 'This candidate has been rejected.');
      if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion !== record.version && !(receipt && input.expectedVersion === record.version - 1))) {
        throw new PersonalDataError('STALE_VERSION', 'Reload this candidate before reviewing it.');
      }
      if (!receipt && this.blocked(record)) throw new PersonalDataError('FORGOTTEN_FACT', 'This fact was rejected or forgotten; use an explicit memory action.');
      const action = receipt ? { id: receipt.reviewActionId } : auditAction(this.db, 'candidate.accept',
        { candidateId: record.id, candidateVersion: record.version, mode: input.mode || 'create', memoryId: input.memoryId, memoryVersion: input.memoryVersion });
      const reviewed = this.memory.acceptReviewedCandidate({ ...record, mode: input.mode || 'create', memoryId: input.memoryId, memoryVersion: input.memoryVersion }, record.source, action.id);
      if (receipt) this.db.prepare('INSERT OR IGNORE INTO app_actions(id,kind,details,created_at) VALUES(?,?,?,?)')
        .run(reviewed.reviewActionId, 'candidate.accept', JSON.stringify({ candidateId: record.id, recoveredReceipt: true }), reviewed.record.updatedAt);
      const candidate = record.status === 'accepted' ? record : this.save({ ...record, status: 'accepted', version: record.version + 1,
        memoryId: reviewed.record.id, reviewActionId: reviewed.reviewActionId, updatedAt: new Date().toISOString() });
      return { candidate: this.view(candidate), memory: reviewed.record };
    });
  }
  reject(input) {
    return atomic(this.db, () => {
      let record = this.get(input.id);
      record = this.reconcile(record);
      if (record.status === 'accepted') throw new PersonalDataError('CANDIDATE_ALREADY_ACCEPTED', 'The fact is already saved; use forget to remove it.');
      if (record.status === 'rejected' && input.expectedVersion === record.version - 1) return this.view(record);
      if (input.expectedVersion !== record.version) throw new PersonalDataError('STALE_VERSION', 'Reload this candidate before reviewing it.');
      if (record.status === 'rejected') return this.view(record);
      const action = auditAction(this.db, 'candidate.reject', { candidateId: record.id, candidateVersion: record.version });
      this.db.prepare('INSERT OR IGNORE INTO personal_memory_candidate_blocks(slot_key,action_id,created_at) VALUES(?,?,?)')
        .run(slotFor(record), action.id, action.createdAt);
      for (const row of this.db.prepare("SELECT record FROM personal_memory_candidates WHERE status='pending' AND slot_key=?").all(slotFor(record))) {
        const pending = JSON.parse(row.record);
        this.save({ ...pending, status: 'rejected', version: pending.version + 1, reviewActionId: action.id,
          rejectionReason: 'user_rejected_slot', updatedAt: action.createdAt });
      }
      return this.view(this.get(record.id));
    });
  }
}
