import { MemoryStore } from './store.mjs';
import { ProfileStore, openApplicationDatabase, auditAction, appSource } from './profile.mjs';
import { CandidateStore } from './candidates.mjs';
import { MemoryCapture } from './capture.mjs';
import { boundedText, requireSafeFact, PersonalDataError } from './safety.mjs';
import { resolve } from 'node:path';
import { FileMemory } from './files.mjs';
import { ConversationIndex } from './conversations.mjs';

export class MemoryController {
  constructor({ applicationPath, memoryPath, memory, llm, captureLimits, memoryDirectory, soulTemplate } = {}) {
    if (typeof applicationPath !== 'string' || !applicationPath || (!memory && (typeof memoryPath !== 'string' || !memoryPath))) {
      throw new PersonalDataError('INVALID_CONFIG', 'Separate application and memory database paths are required.');
    }
    if (memoryPath && applicationPath !== ':memory:' && memoryPath !== ':memory:'
      && resolve(applicationPath).toLocaleLowerCase('en-US') === resolve(memoryPath).toLocaleLowerCase('en-US')) {
      throw new PersonalDataError('INVALID_CONFIG', 'Application review state and formal facts need separate database files.');
    }
    this.applicationPath = applicationPath;
    this.db = openApplicationDatabase(applicationPath);
    this.memory = memory || new MemoryStore(memoryPath);
    this.ownsMemory = !memory;
    this.profile = new ProfileStore(this.db);
    this.candidates = new CandidateStore(this.db, this.memory);
    this.capture = new MemoryCapture(this, llm, captureLimits);
    this.conversations = new ConversationIndex(this.db);
    if (memoryDirectory) {
      this.files = new FileMemory(memoryDirectory, { store: this.memory, soulTemplate });
      this.unsubscribeFiles = this.memory.subscribe(changes => {
        for (const { record, operation } of changes) this.files.recordRevision(record, operation);
      });
    }
  }
  profileGet() { return this.profile.get(); }
  profileSet(input) { const profile = this.profile.set(input); this.capture.onProfileChanged(); return profile; }
  profileContext() { return this.profile.context(); }
  memoryFilesGet(path) { return path ? this.files.get(path, { lines: 120 }) : this.files.list(); }
  memoryFilesEdit(input) {
    const result = this.files.edit(input);
    const action = auditAction(this.db, 'memory.note-edit', { path: result.path, sha256: result.sha256 });
    this.files.appendDaily(`note-source path=${result.path} source=${JSON.stringify(appSource(action))}`);
    return result;
  }
  candidatesList(input) { return this.candidates.list(input); }
  candidatesAccept(input) { return this.candidates.accept(input); }
  candidatesReject(input) { return this.candidates.reject(input); }
  memoryList({ query = '', includeDeleted = false, limit = 100 } = {}) {
    const clean = boundedText(query, 'query', 500, true);
    if (typeof includeDeleted !== 'boolean' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new PersonalDataError('INVALID_INPUT', 'Invalid memory list options.');
    // Management filtering includes tombstones only when explicitly selected; native retrieval uses focused literal queries.
    return this.memory.list({ includeDeleted, limit, query: clean });
  }
  memoryGet({ id }) {
    const record = this.memory.get(id);
    if (record.scope !== 'personal') throw new PersonalDataError('NOT_FOUND', 'Memory was not found.');
    return record;
  }
  memoryHistory({ id }) { this.memoryGet({ id }); return this.memory.history(id); }
  memoryCorrect(input) {
    const record = this.memoryGet(input);
    requireSafeFact({ ...record, text: boundedText(input.text, 'text', 4000) });
    const action = auditAction(this.db, 'memory.correct', { memoryId: record.id, expectedVersion: input.expectedVersion });
    return this.memory.correct({ id: record.id, expectedVersion: input.expectedVersion, text: input.text }, appSource(action));
  }
  memoryForget(input) {
    const record = this.memoryGet(input);
    const action = auditAction(this.db, 'memory.forget', { memoryId: record.id, expectedVersion: input.expectedVersion });
    const result = this.memory.forget({ id: record.id, expectedVersion: input.expectedVersion }, appSource(action));
    // Candidate reads/accepts also consult the facts tombstone, including deletes made by native tools.
    this.candidates.list({ status: 'pending', limit: 100 });
    return result;
  }
  memoryRestore(input) {
    const record = this.memoryGet(input);
    const previous = this.memory.history(record.id).find(version => version.version === input.targetVersion);
    if (previous) requireSafeFact(previous.record);
    const action = auditAction(this.db, 'memory.restore', { memoryId: record.id, expectedVersion: input.expectedVersion, targetVersion: input.targetVersion });
    return this.memory.restore({ id: record.id, expectedVersion: input.expectedVersion, targetVersion: input.targetVersion }, appSource(action));
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.capture.close();
    this.unsubscribeFiles?.();
    this.db.close();
    if (this.ownsMemory) this.memory.close();
  }
}
export const createMemoryController = options => new MemoryController(options);
