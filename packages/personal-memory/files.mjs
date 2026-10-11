/** Standing notes are editable Markdown. Existing fact revisions remain an audit journal. */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { containsSecret, PersonalDataError } from './safety.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim();
export function queryTerms(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100) throw new PersonalDataError('INVALID_QUERY', 'Use a focused query of 1–100 characters.');
  return normalized(query).split(' ').filter(Boolean);
}
/** AND between complete query terms; never split Chinese sentences into weak OR bigrams. */
export function matchesQuery(text, query) { const value = normalized(text); return queryTerms(query).every(term => value.includes(term)); }
export function validateQueries(queries) {
  if (!Array.isArray(queries) || queries.length < 2 || queries.length > 3) throw new PersonalDataError('INVALID_QUERY', 'Provide 2–3 focused queries.');
  queries.forEach(queryTerms); return [...new Set(queries.map(query => query.trim()))];
}
export function safeHistoryText(text) {
  // Credentials are excluded line by line, without throwing away ordinary questions or code.
  return text.split(/\r?\n/u).filter(line => !containsSecret(line) && !/[?&](?:token|key|secret)=/iu.test(line)).join('\n').trim();
}

export class FileMemory {
  constructor(root, { soulTemplate = '# SOUL\n\n以用户选择的名字工作。自然、简洁，诚实地说明边界。\n', store } = {}) {
    this.root = resolve(root); this.store = store;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new PersonalDataError('INVALID_PATH', 'Memory must use its own directory.');
    this.root = realpathSync(this.root);
    for (const folder of ['people', 'groups', 'topics', 'topics/facts']) mkdirSync(this.path(folder), { recursive: true, mode: 0o700 });
    for (const [path, body] of Object.entries({ 'SOUL.md': soulTemplate, 'MEMORY.md': '# MEMORY.md\n\n## Facts\n\n## Preferences\n\n## Decisions\n\n## Commitments\n', 'people/INDEX.md': '# People\n', 'groups/INDEX.md': '# Groups\n' })) {
      if (!existsSync(this.path(path))) this.atomicWrite(path, body);
    }
    // Migration exports current facts into topic pages, never indiscriminately promotes them to standing notes.
    this.syncFacts();
  }
  path(path) {
    if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new PersonalDataError('INVALID_PATH', 'Use a relative memory path.');
    const target = resolve(this.root, path);
    if (!target.startsWith(this.root + sep)) throw new PersonalDataError('INVALID_PATH', 'Path is outside memory.');
    let parent = this.root;
    for (const part of relative(this.root, target).split(sep)) {
      parent = resolve(parent, part);
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new PersonalDataError('INVALID_PATH', 'Memory links are not followed.');
    }
    return target;
  }
  atomicWrite(path, content) {
    const target = this.path(path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); renameSync(temporary, target); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  get(path, { startLine = 1, lines = 80 } = {}) {
    if (!path.endsWith('.md') || !Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(lines) || lines < 1 || lines > 120) throw new PersonalDataError('INVALID_INPUT', 'Choose a Markdown file and a valid line range.');
    const target = this.path(path);
    if (!existsSync(target) || !lstatSync(target).isFile()) throw new PersonalDataError('NOT_FOUND', 'Memory file was not found.');
    if (lstatSync(target).size > 128 * 1024) throw new PersonalDataError('INPUT_LIMIT', 'Split large memory files into topic pages.');
    const text = readFileSync(target, 'utf8');
    return { path, sha256: digest(text), startLine, totalLines: text.split('\n').length, text: safeHistoryText(text.split('\n').slice(startLine - 1, startLine - 1 + lines).join('\n')) };
  }
  edit({ path, expectedHash, oldText, newText }) {
    if (!/^(?:SOUL|MEMORY)\.md$|^(?:people|groups|topics)\/[\p{L}\p{N}_-]+\.md$/u.test(path) || path === 'topics/facts.md') throw new PersonalDataError('INVALID_PATH', 'Edit curated notes or a person/group/topic page. Audited fact pages use the fact tools.');
    if (typeof oldText !== 'string' || typeof newText !== 'string' || newText.length > 12000 || containsSecret(newText)) throw new PersonalDataError('INVALID_INPUT', 'Provide a small replacement without credentials.');
    const target = this.path(path), before = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (expectedHash !== digest(before)) throw new PersonalDataError('STALE_VERSION', 'Read the file again before editing it.');
    if ((!oldText && before) || (oldText && (!before.includes(oldText) || before.indexOf(oldText) !== before.lastIndexOf(oldText)))) throw new PersonalDataError('MEMORY_CONFLICT', 'oldText must identify exactly one passage; empty oldText is only for a new file.');
    const after = oldText ? before.replace(oldText, newText) : newText;
    for (const line of after.split('\n').filter(line => line.includes('<!-- kleio-fact:'))) {
      if (!before.split('\n').includes(line)) throw new PersonalDataError('MEMORY_CONFLICT', 'Correct audited facts through the fact tools; a curated note can unpin but cannot silently rewrite them.');
    }
    if (after.length > 16000 || (path === 'MEMORY.md' && after.split('\n').length > 100)) throw new PersonalDataError('INPUT_LIMIT', 'Keep standing memory under 100 lines; move details into topic pages.');
    this.atomicWrite(path, after);
    this.appendDaily(`note-edit path=${path} before=${digest(before)} after=${digest(after)}`);
    return { path, sha256: digest(after), lines: after.split('\n').length };
  }
  appendDaily(text) {
    const now = new Date().toISOString(), path = `${now.slice(0, 10)}.md`, target = this.path(path);
    // The sole service writer appends; entries contain source references, not API arguments or credentials.
    writeFileSync(target, `${existsSync(target) ? '' : `# ${now.slice(0, 10)}\n\n`}- ${now} ${text.replaceAll('\n', ' ')}\n`, { flag: 'a', mode: 0o600 });
  }
  syncFacts() {
    if (!this.store) return;
    const rows = this.store.db.prepare("SELECT record FROM personal_memories WHERE scope='personal'").all().map(row => JSON.parse(row.record));
    for (const record of rows) {
      const path = `topics/facts/${record.id}.md`;
      if (record.deleted || containsSecret(record.text)) { if (existsSync(this.path(path))) unlinkSync(this.path(path)); }
      else this.atomicWrite(path, `# ${record.subject} — ${record.key}\n\n- ${record.text.replaceAll('\n', ' ')}\n\n<!-- kleio-fact:${record.id} version:${record.version} -->\n日期：${record.updatedAt}\n来源：${JSON.stringify(record.source)}\n`);
    }
    // A pinned audited fact is replaced in place after correction, and removed after forgetting.
    const target = this.path('MEMORY.md');
    if (existsSync(target)) {
      const before = readFileSync(target, 'utf8');
      const after = before.split('\n').map(line => {
        const id = line.match(/<!-- kleio-fact:([\w-]+) -->/u)?.[1];
        if (!id) return line;
        const current = rows.find(row => row.id === id);
        return current && !current.deleted ? this.standingLine(current) : '';
      }).join('\n');
      if (after !== before) this.atomicWrite('MEMORY.md', after);
    }
  }
  standingLine(record) { return `- ${record.subject}／${record.key}：${record.text.replaceAll('\n', ' ')} (${record.updatedAt.slice(0, 10)}，${record.source.kind || 'conversation'}，${record.source.sessionId}) <!-- kleio-fact:${record.id} -->`; }
  pin(record) {
    const before = readFileSync(this.path('MEMORY.md'), 'utf8');
    if (before.includes(`<!-- kleio-fact:${record.id} -->`)) return;
    const after = `${before.trimEnd()}\n${this.standingLine(record)}\n`;
    if (after.split('\n').length > 100 || after.length > 16000) throw new PersonalDataError('INPUT_LIMIT', 'Standing memory is full; the fact remains available in topic search.');
    this.atomicWrite('MEMORY.md', after);
  }
  recordRevision(record, operation) {
    this.syncFacts();
    this.appendDaily(`${operation} fact=${record.id} version=${record.version}${operation.includes('correct') ? ` supersedes=${record.id}:v${record.version - 1}` : ''} source=${JSON.stringify(record.source)} current=topics/facts/${record.id}.md`);
  }
  list() {
    const result = [];
    const visit = (folder = '', depth = 0) => {
      if (depth > 3 || result.length >= 200) return;
      for (const entry of readdirSync(folder ? this.path(folder) : this.root, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.md')) result.push({ path, editable: /^(?:SOUL|MEMORY)\.md$|^(?:people|groups|topics)\/[\p{L}\p{N}_-]+\.md$/u.test(path) });
      }
    };
    visit(); return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  standing() {
    const paths = ['MEMORY.md', 'people/INDEX.md', 'groups/INDEX.md'];
    const notes = paths.map(path => this.get(path, { lines: 120 }));
    const overBudget = notes.some(note => note.totalLines > 120 || note.text.length > 16000);
    if (overBudget) throw new PersonalDataError('MEMORY_BUDGET', 'Standing notes exceed 120 lines or 16000 characters. Split them before starting a session.');
    return { soul: this.get('SOUL.md', { lines: 120 }).text, notes: notes.map(({ path, text }) => ({ path, text })) };
  }
  search(queries, limit = 6) {
    validateQueries(queries); const hits = [];
    const visit = (folder, depth = 0) => {
      if (depth > 3) return;
      for (const entry of readdirSync(this.path(folder), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = `${folder}/${entry.name}`;
        if (entry.isDirectory()) { visit(path, depth + 1); continue; }
        if (entry.isFile() && entry.name.endsWith('.md')) scan(path);
      }
    };
    const scan = path => {
      if (path === 'SOUL.md') return;
      const target = this.path(path); if (lstatSync(target).size > 128 * 1024) return;
      const text = safeHistoryText(readFileSync(target, 'utf8'));
      const rows = text.split('\n');
      // Fact pages contain one sourced fact; general pages match one paragraph at a time.
      const segments = path.startsWith('topics/facts/') ? [{ text, line: 1 }] : rows.map((text, i) => ({ text, line: i + 1 }));
      for (const segment of segments) if (queries.some(query => matchesQuery(segment.text, query))) {
        hits.push({ kind: /^\d{4}-\d{2}-\d{2}\.md$/u.test(path) ? 'daily-log' : 'saved-memory', path, line: segment.line, excerpt: segment.text.slice(0, 1400) });
      }
    };
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) scan(entry.name);
      if (entry.isDirectory() && ['people', 'groups', 'topics'].includes(entry.name)) visit(entry.name);
    }
    return hits.sort((a, b) => Number(a.kind === 'daily-log') - Number(b.kind === 'daily-log') || a.path.localeCompare(b.path) || a.line - b.line).slice(0, limit);
  }
}
