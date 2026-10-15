import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb, WebSearchError } from './web-search.ts';

const dummyKey = 'local-placeholder-key';
const success = () => Response.json({ results: [] });
const safeError = (code: string) => (error: unknown) => {
  assert(error instanceof WebSearchError); assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /local-placeholder-key|PRIVATE_PROVIDER_MARKER/);
  return true;
};

test('transient gateway errors get one retry with the same request and 25s deadline', async t => {
  for (const status of [502, 503, 504]) await t.test(String(status), async t => {
    const deadline = new AbortController(); let deadlines = 0; let calls = 0; let disposed = 0;
    const signals: Array<AbortSignal | null | undefined> = []; const bodies: unknown[] = [];
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 25_000); deadlines += 1; return deadline.signal; });
    t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      assert.equal(url, 'https://api.tavily.com/search'); assert.equal(options.redirect, 'error');
      signals.push(options.signal); bodies.push(options.body);
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${dummyKey}`);
      calls += 1;
      return calls === 1 ? new Response(new ReadableStream({ cancel() { disposed += 1; } }), { status }) : success();
    });
    assert.deepEqual(await searchWeb({ query: '  public evidence  ', maxResults: 2 }, { apiKey: dummyKey }), { query: 'public evidence', results: [], warnings: [], truncated: false });
    assert.equal(calls, 2); assert.equal(disposed, 1); assert.equal(deadlines, 1);
    assert.equal(signals[0], signals[1]); assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(JSON.parse(String(bodies[0])), { query: 'public evidence', max_results: 2, search_depth: 'basic', topic: 'general', auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false });
  });
});

test('transient connection and response stream failures get one retry', async t => {
  for (const code of ['ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) await t.test(code, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('PRIVATE_PROVIDER_MARKER', { cause: Object.assign(new Error('private transport'), { code }) });
      return success();
    });
    assert.equal((await searchWeb({ query: 'public evidence' })).results.length, 0);
    assert.equal(calls, 2);
  });
  await t.test('interrupted response stream', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return calls === 1 ? new Response(new ReadableStream({ start(controller) {
        controller.error(new TypeError('PRIVATE_PROVIDER_MARKER', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) }));
      } })) : success();
    });
    await searchWeb({ query: 'public evidence' }); assert.equal(calls, 2);
  });
});

test('retry stops after two total attempts and never leaks provider or transport data', async t => {
  await t.test('gateway outage', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('PRIVATE_PROVIDER_MARKER', { status: 503 }); });
    await assert.rejects(searchWeb({ query: 'public evidence' }, { apiKey: dummyKey }), safeError('search_provider'));
    assert.equal(calls, 2);
  });
  await t.test('network outage', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw Object.assign(new Error('PRIVATE_PROVIDER_MARKER'), { code: 'ECONNRESET' }); });
    await assert.rejects(searchWeb({ query: 'public evidence' }, { apiKey: dummyKey }), safeError('search_transport'));
    assert.equal(calls, 2);
  });
});

test('auth, request, rate, quota and other HTTP failures are never retried', async t => {
  for (const [status, code] of [[400, 'search_request'], [401, 'search_auth'], [403, 'search_auth'], [422, 'search_request'], [429, 'search_limit'], [432, 'search_limit'], [433, 'search_limit'], [500, 'search_provider']] as const) {
    await t.test(String(status), async t => {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('PRIVATE_PROVIDER_MARKER', { status }); });
      await assert.rejects(searchWeb({ query: 'public evidence' }, { apiKey: dummyKey }), safeError(code));
      assert.equal(calls, 1);
    });
  }
});

test('permanent transport and invalid responses are never retried', async t => {
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UND_ERR_INVALID_ARG', 'UNEXPECTED_REDIRECT']) await t.test(code, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new TypeError('PRIVATE_PROVIDER_MARKER', { cause: Object.assign(new Error('private cause'), { code }) }); });
    await assert.rejects(searchWeb({ query: 'public evidence' }), safeError('search_transport')); assert.equal(calls, 1);
  });
  for (const [name, response, code] of [
    ['invalid JSON', () => new Response('PRIVATE_PROVIDER_MARKER'), 'search_response'],
    ['invalid shape', () => Response.json({ private: 'PRIVATE_PROVIDER_MARKER' }), 'search_response'],
    ['oversized response', () => new Response('PRIVATE_PROVIDER_MARKER', { headers: { 'content-length': '256001' } }), 'search_response_limit'],
  ] as const) await t.test(name, async t => {
    let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response(); });
    await assert.rejects(searchWeb({ query: 'public evidence' }), safeError(code)); assert.equal(calls, 1);
  });
});

test('caller cancellation and deadline expiry interrupt retry waits', async t => {
  for (const timeout of [false, true]) await t.test(timeout ? 'deadline' : 'caller cancellation', async t => {
    const stop = new AbortController(); let calls = 0;
    if (timeout) t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 25_000); return stop.signal; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    t.after(() => { if (timer) clearTimeout(timer); });
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1; timer = setTimeout(() => stop.abort(), 10);
      return new Response('PRIVATE_PROVIDER_MARKER', { status: 503 });
    });
    await assert.rejects(searchWeb({ query: 'public evidence' }, {}, timeout ? undefined : stop.signal), safeError(timeout ? 'search_timeout' : 'search_cancelled'));
    assert.equal(calls, 1);
  });
});

test('input caps and private citation filtering remain enforced after retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return calls === 1 ? new Response('', { status: 503 }) : Response.json({ results: [{ url: 'http://127.0.0.1/private', title: 'private', content: 'private' }, { url: 'https://user:password@example.com/', title: 'private', content: 'private' }] });
  });
  for (const input of [{ query: '' }, { query: 'x'.repeat(1001) }, { query: 'public', maxResults: 4 }]) await assert.rejects(searchWeb(input), safeError('search_input'));
  assert.equal(calls, 0);
  const result = await searchWeb({ query: 'public evidence' });
  assert.deepEqual(result.results, []); assert.equal(result.truncated, true); assert.equal(calls, 2);
  assert(result.warnings.some(warning => warning.includes('not public')));
});
