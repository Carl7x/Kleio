/** A one-execution, authenticated loopback MCP capability bridge. */
import { createServer, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ExecutionContext, ToolDefinition } from '../../runtime/contracts.ts';

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function send(res: ServerResponse, status: number, value?: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}

export async function createProductMcpBridge(tools: ToolDefinition[], context: ExecutionContext, valid: (schema: unknown, value: unknown) => boolean) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const catalog = new Map(tools.map(tool => [tool.name, tool]));
  if (catalog.size !== tools.length) throw new Error('Duplicate product tool name.');
  const calls = new Set<Promise<unknown>>();
  const receipts = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  let active = true;
  const server = createServer(async (req, res) => {
    const received = Buffer.from(req.headers.authorization ?? '');
    if (!active || context.signal.aborted || received.length !== expected.length || !timingSafeEqual(received, expected) || req.headers.origin !== undefined || req.url !== '/mcp') return send(res, 403);
    if (req.method !== 'POST') return send(res, 405);
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        const data = Buffer.from(chunk); bytes += data.length;
        if (bytes > 256 * 1024) return send(res, 413);
        chunks.push(data);
      }
      const message: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return send(res, 400);
      if (!('id' in message)) return send(res, 202);
      if (typeof message.id !== 'string' && typeof message.id !== 'number') return send(res, 400);
      const params = object(message.params) ? message.params : {};
      const reply = (result: unknown) => send(res, 200, { jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') return reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'kleio-product-tools', version: '1.0.0' } });
      if (message.method === 'ping') return reply({});
      if (message.method === 'tools/list') return reply({ tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
      if (message.method === 'tools/call') {
        if (!active || context.signal.aborted || typeof params.name !== 'string' || !catalog.has(params.name) || !object(params.arguments ?? {})) return send(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Tool is outside this execution or arguments are invalid.' } });
        if (!valid(catalog.get(params.name)!.inputSchema, params.arguments ?? {})) return send(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Tool arguments do not match the capability schema.' } });
        const id = JSON.stringify(message.id);
        const fingerprint = createHash('sha256').update(JSON.stringify(params)).digest('hex');
        const receipt = receipts.get(id);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) return send(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Request identity belongs to different input.' } });
          return reply(await receipt.result);
        }
        if (receipts.size >= 256) return send(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Execution tool-call budget exhausted.' } });
        const call = Promise.resolve().then(() => {
          if (!active || context.signal.aborted) throw new Error('Execution stopped.');
          return context.callTool(params.name as string, (params.arguments ?? {}) as JsonObject);
        });
        calls.add(call);
        const result = (async () => {
          try {
            const result = await call;
            const text = JSON.stringify(result === undefined ? null : result);
            return { content: [{ type: 'text', text }] };
          } catch {
            // Product failures are recorded by the caller; avoid exposing arbitrary error text.
            return { isError: true, content: [{ type: 'text', text: 'Product tool failed. Inspect the product execution status.' }] };
          } finally { calls.delete(call); }
        })();
        receipts.set(id, { fingerprint, result });
        return reply(await result);
      }
      return send(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method is not available.' } });
    } catch { if (!res.headersSent) send(res, 400); else res.end(); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Product tool bridge did not start.');
  const revoke = () => { active = false; };
  context.signal.addEventListener('abort', revoke, { once: true });
  return {
    declaration: { type: 'http', name: 'kleio', url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
    async close(): Promise<boolean> {
      active = false; context.signal.removeEventListener('abort', revoke);
      server.close(); server.closeAllConnections();
      if (!calls.size) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([Promise.allSettled([...calls]).then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
      if (timer) clearTimeout(timer);
      return settled;
    },
  };
}
