import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './store.mjs';

const source = { sessionId: 'synthetic-session', turnId: '1', messageId: 'synthetic-message' };
const changedSource = { sessionId: 'synthetic-session-2', turnId: '2', messageId: 'synthetic-message-2' };
function fixture(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-owned-memory-'));
  const file = join(directory, 'memory.sqlite');
  const store = new MemoryStore(file);
  try { callback(store, file); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const fact = { subject: '虚构验收小林', key: '饮品偏好', text: '喜欢桂花乌龙，不加糖。' };

test('Chinese memory survives closing and reopening the owning service', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-owned-memory-'));
  const file = join(directory, 'memory.sqlite');
  const original = new MemoryStore(file);
  const record = original.remember(fact, source);
  original.close();
  const reopened = new MemoryStore(file);
  try { assert.equal(reopened.search({ query: '小林 饮品' })[0].id, record.id); assert.deepEqual(reopened.get(record.id).source, source); }
  finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('deduplication is idempotent while conflicting facts require explicit correction', () => fixture(store => {
  const record = store.remember(fact, source);
  const same = store.remember({ ...fact, text: ' 喜欢桂花乌龙，不加糖。 ' }, changedSource);
  assert.equal(same.id, record.id); assert.equal(store.history(record.id).length, 1);
  assert.throws(() => store.remember({ ...fact, text: '喜欢咖啡。' }, changedSource), { code: 'MEMORY_CONFLICT' });
  assert.equal(store.search({ query: '桂花乌龙' }).length, 1);
}));

test('stale updates cannot silently overwrite newer facts', () => fixture((store, file) => {
  const record = store.remember(fact, source);
  const secondOwner = new MemoryStore(file);
  try {
    const updated = store.correct({ id: record.id, expectedVersion: 1, text: '喜欢茉莉冷泡。' }, changedSource);
    assert.equal(updated.version, 2);
    assert.throws(() => secondOwner.correct({ id: record.id, expectedVersion: 1, text: '喜欢咖啡。' }, source), { code: 'STALE_VERSION' });
    assert.equal(secondOwner.search({ query: '桂花乌龙' }).length, 0);
    assert.equal(secondOwner.search({ query: '茉莉冷泡' })[0].id, record.id);
  } finally { secondOwner.close(); }
}));

test('recoverable forgetting leaves no deleted content in normal retrieval', () => fixture(store => {
  const record = store.remember(fact, source);
  const deleted = store.forget({ id: record.id, expectedVersion: 1 }, changedSource);
  assert.equal(deleted.deleted, true); assert.equal(store.list().length, 0);
  assert.equal(store.search({ query: '小林' }).length, 0);
  assert.equal(store.list({ includeDeleted: true }).length, 1);
  assert.equal(store.history(record.id)[1].operation, 'forget');
  const restored = store.restore({ id: record.id, expectedVersion: 2, targetVersion: 1 }, source);
  assert.equal(restored.version, 3); assert.equal(restored.deleted, false);
  assert.equal(store.search({ query: '桂花乌龙' }).length, 1);
}));

test('restoring an old fact cannot displace an active replacement', () => fixture(store => {
  const old = store.remember(fact, source);
  store.forget({ id: old.id, expectedVersion: 1 }, source);
  const replacement = store.remember({ ...fact, text: '喜欢茉莉茶。' }, changedSource);
  assert.throws(() => store.restore({ id: old.id, expectedVersion: 2, targetVersion: 1 }, source), { code: 'MEMORY_CONFLICT' });
  assert.equal(store.list()[0].id, replacement.id);
  assert.equal(store.get(old.id).version, 2);
}));

test('provenance is mandatory and scopes are kept out of unrelated recall', () => fixture(store => {
  assert.throws(() => store.remember(fact, {}), { code: 'INVALID_INPUT' });
  assert.throws(() => store.remember(fact), { code: 'SOURCE_REQUIRED' });
  store.remember({ ...fact, scope: 'project:test' }, source);
  assert.equal(store.search({ query: '桂花乌龙' }).length, 0);
  assert.equal(store.search({ query: '桂花乌龙', scope: 'project:test' }).length, 1);
}));

test('migration is atomic and retry-safe without inventing conversation provenance', () => fixture(store => {
  const rows = [JSON.stringify({ type: 'entity', name: '虚构迁移用户', observations: ['喜欢绿茶。', '仅用于验收。'] })];
  assert.deepEqual(store.importReferenceGraph(rows, 'fixture-v1'), { imported: 2, alreadyImported: false });
  assert.deepEqual(store.importReferenceGraph(rows, 'fixture-v1'), { imported: 0, alreadyImported: true });
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].kind, 'imported');
  assert.equal(store.list()[0].source.sessionId, 'legacy-reference-import');
  assert.throws(() => store.importReferenceGraph([...rows, '{broken-json'], 'fixture-broken'));
  assert.equal(store.list().length, 2);
}));

test('untrusted FTS syntax is treated as query text and search is explicitly lexical', () => fixture(store => {
  store.remember(fact, source);
  assert.equal(store.search({ query: '"; OR * NEAR()' }).length, 0);
  assert.equal(store.search({ query: '下午提神饮料' }).length, 0);
  assert.throws(() => store.search({ query: '茶', limit: 10000 }), { code: 'INVALID_INPUT' });
}));

test('case-sensitive and Unicode fact corrections preserve the requested new value', () => fixture(store => {
  const record = store.remember({ subject: '验收项目', key: '分支', text: 'Release' }, source);
  const edited = store.correct({ id: record.id, expectedVersion: 1, text: 'release' }, changedSource);
  assert.equal(edited.text, 'release'); assert.equal(edited.version, 2);
  const fullwidth = store.correct({ id: record.id, expectedVersion: 2, text: 'ｒｅｌｅａｓｅ' }, source);
  assert.equal(fullwidth.text, 'ｒｅｌｅａｓｅ'); assert.equal(fullwidth.version, 3);
}));

test('mixed Chinese/Latin text, single-character queries and forgotten fact tombstones work', () => fixture(store => {
  const record = store.remember({ subject: '虚构验收小林', key: '爱好', text: 'OpenAI烘焙，以及绿茶' }, source);
  assert.equal(store.search({ query: '烘焙' })[0].id, record.id);
  assert.equal(store.search({ query: '茶' })[0].id, record.id);
  store.forget({ id: record.id, expectedVersion: 1 }, source);
  assert.throws(() => store.remember({ subject: '虚构验收小林', key: '爱好', text: '绿茶', kind: 'inferred' }, changedSource), { code: 'FORGOTTEN_FACT' });
  assert.equal(store.list().length, 0);
}));
