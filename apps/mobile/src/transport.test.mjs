import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('native conversation and execution streams share authenticated expo transport; reads retain native fetch', async () => {
  const source = await readFile(new URL('./transport.ts', import.meta.url), 'utf8');
  const key = `kleioTransport${crypto.randomUUID()}`;
  const calls = [];
  const normal = globalThis.fetch;
  globalThis[key] = async (url, init) => { calls.push(['expo', url, init]); return new Response(); };
  globalThis.fetch = async (url, init) => { calls.push(['native', url, init]); return new Response(); };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace(/import \{ Platform \} from ['"]react-native['"];?/, "const Platform = { OS: 'ios' };")
    .replace(/import \{ fetch as expoFetch \} from ['"]expo\/fetch['"];?/, `const expoFetch = globalThis[${JSON.stringify(key)}];`);
  try {
    const transport = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    transport.setTransport('http://localhost:4317', 'synthetic-device-token');
    const controller = new AbortController();
    for (const path of ['/api/conversations/a/stream?after=0', '/api/executions/e/stream?after=2', '/api/conversations/a/messages']) {
      await transport.clientFetch(path, { signal: controller.signal });
    }
    assert.deepEqual(calls.map(value => value[0]), ['expo', 'expo', 'native']);
    for (const [, url, init] of calls) {
      assert.ok(url.startsWith('http://localhost:4317/api/'));
      assert.equal(init.headers.get('Authorization'), 'Bearer synthetic-device-token');
      assert.equal(init.signal, controller.signal);
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
    }
  } finally { globalThis.fetch = normal; delete globalThis[key]; }
});
