/** Rebuildable text index of native user/assistant messages; excludes prompts, reasoning and tools. */
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { matchesQuery, validateQueries, safeHistoryText, queryTerms } from './files.mjs';

export class ConversationIndex {
  constructor(db) {
    this.db = db;
    this.turns = new Map();
    db.function('kleio_normalize', { deterministic: true }, value => value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim());
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_text(session_id TEXT NOT NULL,event_seq INTEGER NOT NULL,role TEXT NOT NULL,turn INTEGER,text TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,event_seq));`);
    this.health = { indexedSessions: 0, skippedSessions: 0, failedSessions: 0 };
  }
  ingest(header, events) {
    if (!header?.id || header.origin === 'subagent' || header.delegationDepth > 0) return;
    const insert = this.db.prepare('INSERT OR REPLACE INTO conversation_text(session_id,event_seq,role,turn,text,created_at) VALUES(?,?,?,?,?,?)');
    for (const event of events) {
      if (event.type === 'turn/start') { this.turns.set(header.id, event.data.turn); continue; }
      let role, content;
      if (event.type === 'user/message' && event.data.source?.kind === 'user') { role = 'user'; content = event.data.content; }
      else if (event.type === 'assistant/message') { role = 'assistant'; content = event.data.message?.content; }
      else continue;
      const text = safeHistoryText((content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
      if (!text || text.length > 64000 || !Number.isSafeInteger(event.seq)) continue;
      insert.run(String(header.id), event.seq, role, event.data.turn ?? this.turns.get(header.id) ?? null, text, String(event.timestamp || header.createdAt || 'unknown'));
    }
  }
  async importNative(home) {
    if (!home) return;
    const sessions = join(home, 'sessions'); let workspaces;
    try { workspaces = await readdir(sessions, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let count = 0;
    for (const workspace of workspaces.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())) {
      for (const session of await readdir(join(sessions, workspace.name), { withFileTypes: true })) {
        if (!session.isDirectory() || session.isSymbolicLink()) continue;
        if (++count > 500) { this.health.skippedSessions++; continue; }
        const file = join(sessions, workspace.name, session.name, 'session.v4.jsonl.zstd');
        try {
          const stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) { this.health.skippedSessions++; continue; }
          let bytes = await readFile(file), size = 0; const entries = [];
          while (bytes.length) {
            const decoded = zstdDecompressSync(bytes, { info: true, maxOutputLength: 16 * 1024 * 1024 });
            size += decoded.buffer.length;
            if (!decoded.engine.bytesWritten || size > 32 * 1024 * 1024) throw new Error('SESSION_LIMIT');
            entries.push(...decoded.buffer.toString('utf8').split('\n').filter(Boolean).map(JSON.parse));
            bytes = bytes.subarray(decoded.engine.bytesWritten);
          }
          this.ingest(entries.find(entry => entry.type === 'session'), entries.filter(entry => entry.type !== 'session'));
          this.health.indexedSessions++;
        } catch (error) { if (error.code !== 'ENOENT') this.health.failedSessions++; }
      }
    }
  }
  search(queries, { limit = 6, excludeSessionId, beforeSeq = 0 } = {}) {
    validateQueries(queries);
    const terms = queries.map(queryTerms), first = terms.map(terms => terms[0]);
    const expressions = terms.map(parts => `(${parts.map(() => 'instr(kleio_normalize(text),?)>0').join(' AND ')})`);
    const rows = this.db.prepare(`SELECT * FROM conversation_text WHERE (session_id!=? OR event_seq<?) AND (${expressions.join(' OR ')}) ORDER BY rowid DESC LIMIT 200`).all(excludeSessionId || '', beforeSeq, ...terms.flat());
    return rows.filter(row => queries.some(query => matchesQuery(row.text, query))).slice(0, limit).map(row => {
      const term = first.find(term => row.text.toLocaleLowerCase('zh-CN').includes(term)) || first[0];
      const start = Math.max(0, row.text.toLocaleLowerCase('zh-CN').indexOf(term) - 160);
      return { kind: 'past-conversation', sessionId: row.session_id, eventSeq: row.event_seq, turn: row.turn, role: row.role, createdAt: row.created_at, excerpt: row.text.slice(start, start + 1400), historical: true };
    });
  }
}
