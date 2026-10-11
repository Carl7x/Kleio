import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './api.mjs';

test('same-origin transport encodes identifiers and preserves expected versions', async () => {
  const seen = [];
  const api = createApi(async (...args) => { seen.push(args); return new Response(JSON.stringify({ data: { version: 3 } })); });
  assert.deepEqual(await api.correctMemory('a/b', { expectedVersion: 2, text: '中文' }), { version: 3 });
  assert.equal(seen[0][0], '/api/kleio/memories/a%2Fb');
  assert.equal(seen[0][1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(seen[0][1].body), { expectedVersion: 2, text: '中文' });
});

test('an uncertain mutation is reported and is not automatically retried', async () => {
  let count = 0;
  const api = createApi(async () => { count++; throw new Error('disconnected'); });
  await assert.rejects(api.createTask({ goal: '验收', requestId: 'one' }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(count, 1);
});

test('stale writes and authorization failures remain distinguishable', async () => {
  const api = createApi(async () => new Response(JSON.stringify({ error: { code: 'STALE_VERSION', message: 'stale' } }), { status: 409 }));
  await assert.rejects(api.forgetMemory('one', 2), error => error.code === 'STALE_VERSION' && error.message.includes('刷新'));
  const unauthorized = createApi(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }));
  await assert.rejects(unauthorized.profile(), error => error.status === 401 && error.message.includes('重新打开'));
});

test('a malformed successful mutation never presents success', async () => {
  const api = createApi(async () => new Response('<html>error</html>'));
  await assert.rejects(api.saveProfile({ expectedVersion: 1 }), { code: 'OUTCOME_UNKNOWN' });
});
