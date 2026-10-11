import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mountApplicationHttp } from './http.mjs';

function setup({ rejection, memory = {}, tasks = {}, artifacts = {} } = {}) {
  let route;
  const ctx = { connection: { admit: () => rejection ? { rejection } : { peer: {} } },
    effect: action => action(), webServer: { register: value => { route = value; return () => {}; } } };
  mountApplicationHttp(ctx, { memory, tasks, artifacts, routines: {} });
  return async (url, { method = 'GET', input, raw, contentType = 'application/json' } = {}) => {
    const req = Readable.from(raw === undefined ? input === undefined ? [] : [Buffer.from(JSON.stringify(input))] : [Buffer.from(raw)]);
    req.url = url; req.method = method; req.headers = { 'content-type': contentType };
    const result = {};
    const res = { writeHead: (status, headers) => { result.status = status; result.headers = headers; }, end: text => { result.value = JSON.parse(text); } };
    await route.handler(req, res); return result;
  };
}

test('unauthenticated and untrusted requests never reach personal-data handlers', async () => {
  for (const rejection of [401, 403]) {
    let invoked = false;
    const send = setup({ rejection, memory: { profileGet() { invoked = true; } } });
    assert.equal((await send('/api/kleio/profile')).status, rejection);
    assert.equal(invoked, false);
  }
});

test('the URL owns the mutation identity, and successful writes are not cached', async () => {
  let actual;
  const send = setup({ memory: { memoryCorrect: input => { actual = input; return { version: 2 }; } } });
  const response = await send('/api/kleio/memories/real-id', { method: 'PATCH', input: { id: 'spoofed', expectedVersion: 1, text: 'new' } });
  assert.equal(actual.id, 'real-id'); assert.equal(actual.expectedVersion, 1);
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.value.data.version, 2);
});

test('invalid media, oversized bodies and invalid JSON are rejected before changes', async () => {
  let writes = 0;
  const send = setup({ memory: { profileSet() { writes++; } } });
  for (const [options, status] of [
    [{ contentType: 'text/plain', raw: '{}' }, 415],
    [{ raw: JSON.stringify({ text: 'x'.repeat(65536) }) }, 413],
    [{ raw: '{' }, 400], [{ raw: '[]' }, 400],
  ]) assert.equal((await send('/api/kleio/profile', { method: 'PATCH', ...options })).status, status);
  assert.equal(writes, 0);
});

test('version conflicts stay reviewable and unexpected errors do not reveal internal details', async () => {
  let unexpected = false;
  const send = setup({ memory: { profileSet() { throw unexpected ? new Error('private-path-or-provider-detail') : Object.assign(new Error('changed'), { code: 'STALE_VERSION' }); } } });
  assert.equal((await send('/api/kleio/profile', { method: 'PATCH', input: {} })).status, 409);
  unexpected = true;
  const response = await send('/api/kleio/profile', { method: 'PATCH', input: {} });
  assert.equal(response.status, 500); assert.ok(!JSON.stringify(response.value).includes('private-path'));
});

test('delegation returns the stored task immediately, and results come from the native-present catalog', async () => {
  const send = setup({ tasks: { create: input => ({ id: input.requestId, status: 'queued' }) }, artifacts: { list: input => [{ id: 'presented-file', taskId: input.taskId }] } });
  const created = await send('/api/kleio/tasks', { method: 'POST', input: { requestId: 'request-a', goal: 'produce file' } });
  assert.equal(created.status, 201); assert.equal(created.value.data.status, 'queued');
  assert.equal((await send('/api/kleio/artifacts?taskId=task-a')).value.data[0].taskId, 'task-a');
});
