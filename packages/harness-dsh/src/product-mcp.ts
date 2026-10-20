/** A one-execution, authenticated loopback MCP capability bridge. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ExecutionContext, ToolDefinition } from '../../runtime/contracts.ts';
import type { RequestAdmission } from '../../runtime/request-admission.ts';

type JsonObject = Record<string, unknown>;
const BODY_LIMIT = 256 * 1024;
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function responseOpen(res: ServerResponse): boolean {
  const socket = res.socket;
  return socket != null && !socket.destroyed && !res.destroyed && !res.writableEnded;
}
function send(res: ServerResponse, status: number, value?: unknown): void {
  if (!responseOpen(res) || res.headersSent) return;
  try {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  } catch {
    // The peer can close between the usability check and the write.
  }
}
function endQuietly(res: ServerResponse): void {
  if (!responseOpen(res)) return;
  try { res.end(); } catch { /* peer closed */ }
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const data = Buffer.from(chunk); bytes += data.length;
    if (bytes > BODY_LIMIT) { send(res, 413); return; }
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

/** A private JSON-shaped transport snapshot, independent of caller-owned definitions. */
function frozenToolCopy(tools: ToolDefinition[]): readonly ToolDefinition[] {
  const copy = structuredClone(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy;
}

export async function createProductMcpBridge(tools: ToolDefinition[], context: ExecutionContext, valid: (schema: unknown, value: unknown) => boolean, admission?: RequestAdmission) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const definitions = frozenToolCopy(tools);
  const catalog = new Map(definitions.map(tool => [tool.name, tool]));
  if (catalog.size !== definitions.length) throw new Error('Duplicate product tool name.');
  const calls = new Set<Promise<unknown>>();
  const receipts = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  let active = true;
  const authorized = (req: IncomingMessage): boolean => {
    const received = Buffer.from(req.headers.authorization ?? '');
    return active && !context.signal.aborted && received.length === expected.length && timingSafeEqual(received, expected) && req.headers.origin === undefined;
  };
  const server = createServer((req, res) => {
    // Keep socket and body faults on this exchange. No process-level rejection handler.
    req.on('error', () => {});
    res.on('error', () => {});
    handle(req, res).catch(() => endQuietly(res));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let control = false;
    try {
      if (!authorized(req)) return send(res, 403);
      control = req.url === '/control/request-check';
      if (req.url !== '/mcp' && !(control && admission)) return send(res, 403);
      if (req.method !== 'POST') return send(res, 405);
      const body = await readBody(req, res);
      if (body === undefined) return;
      // A consumed IncomingMessage is destroyed on success. Recheck the execution lifecycle, not req.aborted.
      if (!authorized(req)) return send(res, 403);
      let message: unknown;
      try { message = JSON.parse(body.toString('utf8')); } catch {
        if (!res.headersSent) send(res, 400, control ? { error: 'request-check-rejected' } : undefined);
        return;
      }
      if (control) {
        try {
          const decision = admission!.check(message);
          if (decision.kind === 'allow') {
            return send(res, 200, { decision: 'allow', requestSequence: decision.admission.requestSequence, policyEpoch: decision.admission.policyEpoch, hostGeneration: decision.admission.hostGeneration });
          }
          return send(res, 409, { decision: 'deny', code: decision.receipt.code, requestSequence: decision.receipt.requestSequence, policyEpoch: decision.receipt.policyEpoch, hostGeneration: decision.receipt.hostGeneration });
        } catch {
          if (!res.headersSent) send(res, 400, { error: 'request-check-rejected' });
          else endQuietly(res);
        }
        return;
      }
      try {
        if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return send(res, 400);
        if (!('id' in message)) return send(res, 202);
        if (typeof message.id !== 'string' && typeof message.id !== 'number') return send(res, 400);
        const params = object(message.params) ? message.params : {};
        const reply = (result: unknown) => send(res, 200, { jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'initialize') return reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'kleio-product-tools', version: '1.0.0' } });
        if (message.method === 'ping') return reply({});
        if (message.method === 'tools/list') return reply({ tools: [...catalog.values()].map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
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
      } catch { if (!res.headersSent) send(res, 400); else endQuietly(res); }
    } catch {
      if (res.headersSent) endQuietly(res);
      else send(res, 400, control ? { error: 'request-check-rejected' } : undefined);
    }
  }
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Product tool bridge did not start.');
  const revoke = () => { active = false; };
  context.signal.addEventListener('abort', revoke, { once: true });
  const authorization = `Bearer ${token}`;
  return {
    declaration: { type: 'http', name: 'kleio', url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: 'Authorization', value: authorization }] },
    ...(admission ? { control: { url: `http://127.0.0.1:${address.port}/control/request-check`, authorization } } : {}),
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
