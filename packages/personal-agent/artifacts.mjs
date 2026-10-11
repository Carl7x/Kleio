/** Cross-conversation result index. Files are presented and opened by native dsh. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { mkdirSync } from 'node:fs';

export class ArtifactCatalog {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS personal_artifact_catalog(id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
    `);
  }
  remember(record, sourceKey) {
    const existing = this.db.prepare('SELECT record FROM personal_artifact_catalog WHERE source_key=?').get(sourceKey);
    if (existing) return JSON.parse(existing.record);
    const value = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO personal_artifact_catalog(id,source_key,record) VALUES(?,?,?)').run(value.id, sourceKey, JSON.stringify(value));
    return value;
  }
  list({ taskId, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error('请检查成果数量。'), { code: 'INVALID_LIMIT' });
    const records = this.db.prepare('SELECT record FROM personal_artifact_catalog ORDER BY rowid DESC LIMIT 1000').all().map(row => JSON.parse(row.record));
    const seen = new Set();
    return records.filter(record => {
      if (taskId && record.taskId !== taskId) return false;
      const key = `${record.sessionId}:${record.path}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, limit);
  }
  close() { this.db.close(); }
}

export function mountArtifactCatalog(ctx, { databasePath, tasks }) {
  const catalog = new ArtifactCatalog(databasePath);
  let pending = Promise.resolve(); let disposed = false;
  const stop = ctx.on('session/event', (session, event) => {
    if (disposed || event.type !== 'deliverables/presented' || !Number.isSafeInteger(event.seq)) return;
    pending = pending.then(async () => {
      for (const file of Array.isArray(event.data?.files) ? event.data.files : []) {
        if (typeof file.path !== 'string') continue;
        try {
          const before = await lstat(file.path);
          if (!before.isFile() || before.isSymbolicLink() || before.size > 32 * 1024 * 1024) continue;
          const path = await realpath(file.path);
          const bytes = await readFile(path); const after = await stat(path);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.size !== bytes.length) continue;
          const sourceKey = createHash('sha256').update(`${session.id}:${event.seq}:${path}`).digest('hex');
          const task = tasks.store.bySession(session.id)?.task;
          catalog.remember({ sessionId: String(session.id), path, cwd: session.meta?.cwd || dirname(path), title: basename(path),
            type: extname(path).slice(1) || 'file', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
            description: typeof file.description === 'string' ? file.description.slice(0, 1000) : '', taskId: task?.id || null,
            source: { kind: 'native-present', eventSeq: event.seq, turnId: String(event.data.turn), callId: event.data.callId },
          }, sourceKey);
        } catch { /* A missing/changed file is not indexed as a verified result. */ }
      }
    }).catch(() => { /* A failed index never changes the native execution outcome. */ });
  });
  return {
    list: input => catalog.list(input),
    async whenIdle() { await pending; },
    async dispose() { disposed = true; stop(); await pending; catalog.close(); },
  };
}
