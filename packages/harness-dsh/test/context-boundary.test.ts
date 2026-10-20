/** Real pinned DSH, real product MCP bridge, synthetic localhost model; no paid model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshAcpClient, DshAcpError } from '../src/index.ts';
import { loadProductSchemaValidator, prepareHeadlessLaunch } from '../src/headless.ts';
import { createProductMcpBridge } from '../src/product-mcp.ts';

type Request = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
type Observation = { phase: string; sequence: number; messages?: Array<{ role: string }>; tools?: Array<{ name: string }>;
  frozen?: boolean; tokenMeterPresent?: boolean; unchanged?: boolean };

for (const denyAt of [0, 1, 2]) {
  test(`real DSH request boundary: ${denyAt ? `deny request ${denyAt}` : 'two requests pass'}`, { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kleio-context-boundary-'));
    const recordPath = join(directory, 'observations.jsonl');
    const requests: Request[] = [];
    let writes = 0;
    let serverError: unknown;
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Request;
        requests.push(body);
        const hasResult = body.messages.some(message => message.role === 'tool');
        const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'g0-local', object: 'chat.completion.chunk', created: 1, model: 'g0-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.setHeader('content-type', 'text/event-stream');
        res.write(frame({ role: 'assistant', content: '' }));
        res.write(frame(hasResult ? { content: 'G0_COMPLETED' } : { tool_calls: [{ index: 0, id: 'g0-write', type: 'function', function: { name: 'mcp__kleio__probe_write', arguments: '{"value":"G0_WRITE_INPUT"}' } }] }));
        res.write(frame({}, hasResult ? 'stop' : 'tool_calls'));
        res.end('data: [DONE]\n\n');
      } catch (error) { serverError = error; res.writeHead(500); res.end(); }
    });
    let client: DshAcpClient | undefined;
    let bridge: Awaited<ReturnType<typeof createProductMcpBridge>> | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); assert(address && typeof address !== 'string');
      const options = { dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${address.port}/v1`, id: 'g0-model', apiKey: 'synthetic-local-key', contextWindow: 32768, maxTokens: 2048 } };
      // A missing/wrong runtime is an explicit failure, never a passing skip.
      const launch = await prepareHeadlessLaunch(options, join(directory, 'execution'), ['probe_write']);
      const patchPath = launch.args![launch.args!.indexOf('--patch') + 1]!;
      const patch = JSON.parse(await readFile(patchPath, 'utf8')) as Array<Record<string, unknown>>;
      patch.push({ id: 'compaction-basic', disabled: true }, { id: 'tool-result-pruner', disabled: true },
        { insert: [{ id: 'g0-request-boundary', name: fileURLToPath(new URL('./context-boundary-fixture.mjs', import.meta.url)), config: { recordPath, denyAt } }] });
      assert(patch.some(row => row.id === 'compaction-basic' && row.disabled === true));
      assert(patch.some(row => row.id === 'tool-result-pruner' && row.disabled === true));
      assert(!patch.some(row => row.id === 'token-meter' && row.disabled === true));
      await writeFile(patchPath, JSON.stringify(patch), { mode: 0o600 });
      const schema = await loadProductSchemaValidator(options);
      bridge = await createProductMcpBridge([{ name: 'probe_write', description: 'Perform one synthetic side effect.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }], {
        signal: new AbortController().signal, onText() {}, onEvent() {},
        async callTool(name, args) { assert.equal(name, 'probe_write'); assert.deepEqual(args, { value: 'G0_WRITE_INPUT' }); writes += 1; return { receipt: 'G0_TOOL_RESULT', writes }; },
      }, schema.valid);
      client = new DshAcpClient({ ...launch, promptTimeoutMs: 20_000 });
      await client.start();
      const session = await client.createSession({ cwd: launch.cwd!, mcpServers: [bridge.declaration] });
      const prompt = client.prompt({ sessionId: session.sessionId, text: 'G0_USER_SOURCE: call the supplied tool once, then answer.' });
      if (denyAt) {
        await assert.rejects(prompt, error => {
          assert(error instanceof DshAcpError);
          assert.equal(error.code, -32603); // Actual pinned ACP internal-error outcome, not a product budget code.
          assert.match(error.message, new RegExp(`KLEIO_G0_DENIED_REQUEST_${denyAt}`));
          return true;
        });
      } else assert.equal((await prompt).stopReason, 'end_turn');
      await client.close(); client = undefined;
      assert.equal(await bridge.close(), true); bridge = undefined;
      assert.equal(serverError, undefined);
      assert.equal(requests.length, denyAt === 1 ? 0 : denyAt === 2 ? 1 : 2);
      assert.equal(writes, denyAt === 1 ? 0 : 1);
      const records = (await readFile(recordPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Observation);
      const before = records.filter(row => row.phase === 'before');
      assert.equal(before.length, denyAt === 1 ? 1 : 2);
      for (const row of before) {
        assert.equal(row.frozen, true); assert.equal(row.tokenMeterPresent, true);
        assert(row.messages?.some(message => message.role === 'system'));
        assert.match(JSON.stringify(row.messages), /G0_USER_SOURCE/);
        assert.deepEqual(row.tools?.map(tool => tool.name), ['mcp__kleio__probe_write']);
      }
      if (denyAt !== 1) {
        assert(before[1]!.messages?.some(message => message.role === 'tool'));
        assert.match(JSON.stringify(before[1]!.messages), /G0_TOOL_RESULT/);
      }
      const after = records.filter(row => row.phase === 'after');
      assert.equal(after.length, requests.length);
      assert(after.every(row => row.unchanged));
      for (const request of requests) {
        assert.match(JSON.stringify(request.messages), /G0_USER_SOURCE/);
        assert.deepEqual(request.tools?.map(tool => tool.function.name), ['mcp__kleio__probe_write']);
      }
    } finally {
      try { await client?.close(); } finally {
        try { await bridge?.close(); } finally {
          server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });
}
