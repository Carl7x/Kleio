/** Isolated bridge for HTTP lifecycle regressions. Synthetic ids only. */
import { createProductMcpBridge } from '../src/product-mcp.ts';
import { createRequestAdmission, type RequestAdmission } from '../../runtime/request-admission.ts';

const profile = { version: 'http-lifecycle', contextLimit: 200000, outputLimit: 1024, safetyMarginTokens: 128 };
const admission = createRequestAdmission({
  executionId: 'exec-http-lifecycle',
  scopeId: 'scope-http-lifecycle',
  hostGeneration: 1,
  policyEpoch: 1,
  profile,
  readPolicyEpoch: () => 1,
});
let checks = 0;
let calls = 0;
const observed: RequestAdmission = {
  binding: admission.binding,
  profile: admission.profile,
  denialReceipt: () => admission.denialReceipt(),
  check(input: unknown) {
    checks += 1;
    return admission.check(input);
  },
};
const abort = new AbortController();
const tool = {
  name: 'probe_write',
  description: 'Perform one synthetic side effect.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
};

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const bridge = await createProductMcpBridge([tool], {
  signal: abort.signal,
  onText() {},
  onEvent() {},
  async callTool() {
    calls += 1;
    return { ok: true };
  },
}, () => true, observed);

emit({
  ready: true,
  node: process.version,
  authorization: bridge.control!.authorization,
  mcpUrl: bridge.declaration.url,
  controlUrl: bridge.control!.url,
});

let buffer = '';
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await bridge.close();
  process.exit(0);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (line === 'abort') {
      abort.abort();
      emit({ aborted: abort.signal.aborted, checks, calls });
    } else if (line === 'stats') {
      emit({ aborted: abort.signal.aborted, checks, calls });
    } else if (line === 'close') {
      void shutdown();
    }
  }
});
process.on('SIGTERM', () => { void shutdown(); });
