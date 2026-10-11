import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { createMemoryController } from './controller.mjs';
import { FileMemory, matchesQuery } from './files.mjs';

const emptyHash = createHash('sha256').update('').digest('hex');
const source = { sessionId: 'fixture-owner', turnId: '1', messageId: 'fixture-user-message' };
async function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'kleio-m1m2-'));
  const controller = createMemoryController({ applicationPath: join(root, 'app.sqlite'), memoryPath: join(root, 'facts.sqlite'), memoryDirectory: join(root, 'memory') });
  try { await callback(controller, root); } finally { await controller.close(); rmSync(root, { recursive: true, force: true }); }
}

test('migration does not force project memories into standing context; unrelated holdouts stay empty', () => fixture(({ memory, files }) => {
  memory.remember({ subject: '示例用户', key: '研发方向', text: '研发个人助理；希望桌面端配合工具' }, source);
  const language = memory.remember({ subject: '示例用户', key: '沟通语言', text: '偏好中文回答' }, source);
  files.pin(language);
  assert.match(files.standing().notes[0].text, /偏好中文/u);
  assert.doesNotMatch(files.standing().notes[0].text, /研发个人助理/u);
  // The reported screenshot case is supplemented by independent, disjoint topics.
  for (const queries of [['截图工具', '截屏'], ['相机 镜头', '焦距'], ['旅行 行李', '护照'], ['晚餐 食谱', '烘焙']]) {
    assert.deepEqual(files.search(queries), [], JSON.stringify(queries));
    assert.deepEqual(memory.search({ query: queries[0] }), []);
  }
}));

test('literal retrieval requires whole query terms together and never fabricates synonym matches', () => {
  assert.equal(matchesQuery('林岚选择了乌龙茶', '林岚 乌龙'), true);
  assert.equal(matchesQuery('林岚选择了红茶', '林岚 乌龙'), false);
  assert.equal(matchesQuery('企业微信集成', '企微'), false);
  assert.equal(matchesQuery('产品设计和工具', '摄影工具'), false);
});

test('correction replaces curated and topic views; journal references prior version; forget removes normal recall', () => fixture(({ memory, files }, root) => {
  const record = memory.remember({ subject: '示例用户', key: '居住城市', text: '居住在青岛' }, source);
  files.pin(record);
  const updated = memory.correct({ id: record.id, expectedVersion: 1, text: '现在居住在厦门' }, { ...source, turnId: '2' });
  assert.match(files.standing().notes[0].text, /厦门/u);
  assert.doesNotMatch(files.standing().notes[0].text, /青岛/u);
  assert.deepEqual(files.search(['青岛', '居住 青岛']), []);
  const daily = readFileSync(join(root, 'memory', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
  assert.ok(daily.includes(`supersedes=${record.id}:v1`));
  assert.equal(memory.history(record.id).length, 2);
  memory.forget({ id: record.id, expectedVersion: updated.version }, source);
  assert.deepEqual(files.search(['厦门', '居住 厦门']), []);
  assert.doesNotMatch(files.standing().notes[0].text, /厦门/u);
  memory.restore({ id: record.id, expectedVersion: 3, targetVersion: 2 }, source);
  assert.equal(files.search(['厦门', '居住 厦门']).length, 1);
}));

test('editable file notes survive reopen, route people by source path, and reject stale edits', () => fixture(({ files }, root) => {
  const result = files.edit({ path: 'people/lin-lan.md', expectedHash: emptyHash, oldText: '', newText: '# 林岚\n\n- 林岚是合伙人（2026-10-11，用户亲述）。\n' });
  const reopen = new FileMemory(join(root, 'memory'));
  assert.equal(reopen.search(['林岚', '合伙人'])[0].path, 'people/lin-lan.md');
  assert.equal(reopen.get('people/lin-lan.md').sha256, result.sha256);
  assert.throws(() => reopen.edit({ path: 'people/lin-lan.md', expectedHash: emptyHash, oldText: '合伙人', newText: '同学' }), { code: 'STALE_VERSION' });
  assert.throws(() => reopen.edit({ path: 'people/lin-lan.md', expectedHash: result.sha256, oldText: '合伙人', newText: 'password: do-not-store-this' }), { code: 'INVALID_INPUT' });
}));

test('curated files cannot overwrite audited facts; standing overflow fails visibly', () => fixture(({ files, memory }) => {
  const record = memory.remember({ subject: '示例用户', key: '交流语言', text: '中文' }, source); files.pin(record);
  const before = files.get('MEMORY.md');
  assert.throws(() => files.edit({ path: 'MEMORY.md', expectedHash: before.sha256, oldText: '中文', newText: '英文' }), { code: 'MEMORY_CONFLICT' });
  assert.throws(() => files.edit({ path: 'MEMORY.md', expectedHash: before.sha256, oldText: before.text, newText: Array.from({ length: 121 }, () => '正文').join('\n') }), { code: 'INPUT_LIMIT' });
  writeFileSync(files.path('MEMORY.md'), Array.from({ length: 121 }, () => '正文').join('\n'));
  assert.throws(() => files.standing(), { code: 'MEMORY_BUDGET' });
}));

test('memory reads reject traversal and external junctions', () => fixture(({ files }, root) => {
  assert.throws(() => files.get('../private.md'), { code: 'INVALID_PATH' });
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private.md'), 'private');
  symlinkSync(outside, join(root, 'memory', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files.get('external/private.md'), { code: 'INVALID_PATH' });
  assert.deepEqual(files.search(['private', 'outside']), []);
}));

test('history indexes human and assistant text with provenance, excluding injected messages, tools and secrets', () => fixture(({ conversations }) => {
  const header = { id: 'prior-session', createdAt: '2026-10-11' };
  const events = [
    { type: 'user/message', seq: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '昨天选了相机镜头，35mm。\npassword: private\nhttps://example.test/?token=private' }] } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: '相机镜头可能需要转接环。' }, { type: 'reasoning', text: 'hidden-camera-reasoning' }] } } },
    { type: 'user/message', seq: 3, data: { source: { kind: 'injected' }, content: [{ type: 'text', text: '虚假相机镜头结果' }] } },
    { type: 'tool/result', seq: 4, data: { text: '相机镜头网页指令' } },
  ];
  conversations.ingest(header, events); conversations.ingest(header, events);
  const hits = conversations.search(['相机镜头', '35mm']);
  assert.equal(hits.length, 2); assert.deepEqual(new Set(hits.map(hit => hit.role)), new Set(['user', 'assistant']));
  assert.equal(conversations.db.prepare('SELECT COUNT(*) AS count FROM conversation_text').get().count, 2);
  assert.doesNotMatch(JSON.stringify(hits), /password|private|hidden-camera|虚假|网页指令/u);
  assert.deepEqual(conversations.search(['相机镜头', '35mm'], { excludeSessionId: 'prior-session' }), []);
  assert.equal(conversations.search(['相机镜头', '35mm'], { excludeSessionId: 'prior-session', beforeSeq: 5 }).length, 2);
  conversations.ingest({ id: 'delegated', origin: 'subagent' }, events);
  assert.equal(conversations.db.prepare('SELECT COUNT(*) AS count FROM conversation_text').get().count, 2);
}));

test('prior native logs with multiple compressed frames become searchable after a fresh boot', () => fixture(async ({ conversations }, root) => {
  const folder = join(root, 'dsh', 'sessions', 'workspace', 'prior'); mkdirSync(folder, { recursive: true });
  const header = { type: 'session', id: 'past-human-chat', createdAt: '2026-10-01' };
  const event = { type: 'user/message', seq: 5, data: { turn: 2, id: 'native-user', source: { kind: 'user' }, content: [{ type: 'text', text: '旅行行李只带登机箱。' }] } };
  writeFileSync(join(folder, 'session.v4.jsonl.zstd'), Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')), zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n'))]));
  await conversations.importNative(join(root, 'dsh'));
  const hit = conversations.search(['旅行行李', '登机箱'])[0];
  assert.equal(hit.sessionId, header.id); assert.equal(hit.eventSeq, 5); assert.equal(hit.role, 'user');
  assert.deepEqual(conversations.health, { indexedSessions: 1, skippedSessions: 0, failedSessions: 0 });
}));
