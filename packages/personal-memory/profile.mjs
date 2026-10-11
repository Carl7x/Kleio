import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedText, PersonalDataError } from './safety.mjs';

export function openApplicationDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_actions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS personal_profile(id TEXT PRIMARY KEY CHECK(id='owner'),version INTEGER NOT NULL,record TEXT NOT NULL);`);
  return db;
}
export function atomic(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function auditAction(db, kind, details) {
  const action = { id: randomUUID(), kind, createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO app_actions(id,kind,details,created_at) VALUES(?,?,?,?)')
    .run(action.id, kind, JSON.stringify(details), action.createdAt);
  return action;
}
export const appSource = action => ({ kind: 'app-ui', sessionId: 'app:ui', turnId: action.id, label: action.kind });

export class ProfileStore {
  constructor(db) {
    this.db = db;
    const now = new Date().toISOString();
    const record = { version: 1, assistant: { name: 'Kleio', tone: '自然、简洁', instructions: '' },
      user: { name: '', language: 'zh-CN', timeZone: 'Asia/Shanghai' }, captureEnabled: true, updatedAt: now };
    db.prepare("INSERT OR IGNORE INTO personal_profile(id,version,record) VALUES('owner',1,?)").run(JSON.stringify(record));
    const previous = this.get();
    if (previous.assistant.name === 'Kinloom') {
      this.set({ expectedVersion: previous.version, assistant: { name: 'Kleio' } });
    }
  }
  get() { return JSON.parse(this.db.prepare("SELECT record FROM personal_profile WHERE id='owner'").get().record); }
  set(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PersonalDataError('INVALID_INPUT', 'Provide profile fields.');
    const keys = ['expectedVersion', 'assistant', 'user', 'captureEnabled'];
    if (Object.keys(input).some(key => !keys.includes(key))) throw new PersonalDataError('INVALID_INPUT', 'Unknown profile field.');
    return atomic(this.db, () => {
      const current = this.get();
      if (input.expectedVersion !== current.version) throw new PersonalDataError('STALE_VERSION', 'Reload the profile before changing it.');
      const next = structuredClone(current);
      for (const [group, maximums] of Object.entries({ assistant: { name: 80, tone: 500, instructions: 4000 }, user: { name: 80, language: 40, timeZone: 100 } })) {
        if (input[group] === undefined) continue;
        if (!input[group] || typeof input[group] !== 'object' || Array.isArray(input[group]) || Object.keys(input[group]).some(key => !(key in maximums))) {
          throw new PersonalDataError('INVALID_INPUT', `Invalid ${group} fields.`);
        }
        for (const [key, value] of Object.entries(input[group])) next[group][key] = boundedText(value, key, maximums[key], key === 'instructions' || (group === 'user' && key === 'name'));
      }
      try { Intl.getCanonicalLocales(next.user.language); new Intl.DateTimeFormat('en', { timeZone: next.user.timeZone }); }
      catch { throw new PersonalDataError('INVALID_INPUT', 'Choose a valid language and time zone.'); }
      if (input.captureEnabled !== undefined) {
        if (typeof input.captureEnabled !== 'boolean') throw new PersonalDataError('INVALID_INPUT', 'captureEnabled must be boolean.');
        next.captureEnabled = input.captureEnabled;
      }
      next.version++; next.updatedAt = new Date().toISOString();
      auditAction(this.db, 'profile.update', { previousVersion: current.version, version: next.version, fields: Object.keys(input).filter(key => key !== 'expectedVersion') });
      this.db.prepare("UPDATE personal_profile SET version=?,record=? WHERE id='owner'").run(next.version, JSON.stringify(next));
      return next;
    });
  }
  context() {
    const profile = this.get();
    return [
      `助理名称：${profile.assistant.name}。沟通方式：${profile.assistant.tone}。`,
      `用户选择的称呼：${profile.user.name || '尚未设置'}；首选语言：${profile.user.language}；时区：${profile.user.timeZone}。`,
      profile.assistant.instructions ? `以下是用户在助理设置中保存的工作指引：\n${profile.assistant.instructions}` : '',
      '这些是应用资料和用户设置；个人事实另由个人记忆服务管理，工具授权仍由原生权限系统决定。',
    ].filter(Boolean).join('\n');
  }
}
