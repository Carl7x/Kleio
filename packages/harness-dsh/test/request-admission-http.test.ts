/** Child-process regressions for bridge body cancellation and disconnect. Synthetic traffic only. */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./request-admission-http-fixture.mts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface Ready {
  ready: true;
  node: string;
  authorization: string;
  mcpUrl: string;
  controlUrl: string;
}
interface Stats { aborted: boolean; checks: number; calls: number }
type JsonRecord = Record<string, unknown>;

function controlBody(requestSequence: number): string {
  return JSON.stringify({
    executionId: 'exec-http-lifecycle',
    hostGeneration: 1,
    requestSequence,
    policyEpoch: 1,
    profileVersion: 'http-lifecycle',
    contextLimit: 200000,
    outputLimit: 1024,
    estimatedInputTokens: 10,
    estimatorId: 'synthetic-estimator',
    retainedResourceReceipts: [],
  });
}
function mcpList(): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
}
function mcpCall(): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'probe_write', arguments: { value: 'synthetic' } } });
}

class Fixture {
  readonly child: ChildProcessWithoutNullStreams;
  stderr = '';
  ready!: Ready;
  private buffer = '';
  private readonly queue: JsonRecord[] = [];
  private readonly waiters: Array<{ resolve: (message: JsonRecord) => void; reject: (error: Error) => void }> = [];

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`fixture exited code=${code} signal=${signal}\n${this.stderr}`)));
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line) continue;
      let message: JsonRecord;
      try { message = JSON.parse(line) as JsonRecord; } catch { this.fail(new Error(`non-json fixture output: ${line}`)); return; }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.queue.push(message);
    }
  }

  private closed: Error | undefined;

  private fail(error: Error): void {
    this.closed ??= error;
    const pending = this.waiters.splice(0);
    for (const waiter of pending) waiter.reject(error);
  }

  next(timeoutMs = 5000): Promise<JsonRecord> {
    if (this.closed) return Promise.reject(this.closed);
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (message: JsonRecord) => { clearTimeout(timer); resolve(message); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`fixture timed out\n${this.stderr}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  command(line: string): Promise<Stats> {
    const pending = this.next();
    this.child.stdin.write(`${line}\n`);
    return pending.then(message => {
      assert.equal(typeof message.checks, 'number');
      assert.equal(typeof message.calls, 'number');
      assert.equal(typeof message.aborted, 'boolean');
      return message as unknown as Stats;
    });
  }
}

function assertNoProcessFault(stderr: string): void {
  assert.equal(stderr.includes('triggerUncaughtException'), false, stderr);
  assert.equal(stderr.includes('UnhandledPromiseRejection'), false, stderr);
}

async function startFixture(): Promise<Fixture> {
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const fixture = new Fixture(child);
  try {
    const ready = await fixture.next();
    assert.equal(ready.ready, true);
    assert.equal(String(ready.node).startsWith('v24.'), true, String(ready.node));
    assert.equal(typeof ready.authorization, 'string');
    assert.equal(typeof ready.mcpUrl, 'string');
    assert.equal(typeof ready.controlUrl, 'string');
    fixture.ready = ready as unknown as Ready;
    return fixture;
  } catch (error) {
    await stopFixture(fixture);
    throw error;
  }
}

async function stopFixture(fixture: Fixture): Promise<void> {
  const { child } = fixture;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = once(child, 'exit').then(() => true);
  const timedOut = new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000));
  if (!await Promise.race([exited, timedOut])) child.kill('SIGKILL');
}

async function assertStaysAlive(fixture: Fixture): Promise<void> {
  const exit = once(fixture.child, 'exit').then(([code, signal]) => ({ stayed: false as const, code, signal }));
  const result = await Promise.race([
    exit,
    new Promise<{ stayed: true }>(resolve => setTimeout(() => resolve({ stayed: true }), 500)),
  ]);
  assert.equal(result.stayed, true, fixture.stderr);
  assert.equal(fixture.child.exitCode, null);
  assertNoProcessFault(fixture.stderr);
}

function post(url: string, authorization: string, body: string): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'POST',
      agent: false,
      headers: { authorization, 'content-type': 'application/json', 'content-length': String(payload.length) },
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function disconnectDuringBody(url: string, authorization: string, body: string): Promise<void> {
  const payload = Buffer.from(body);
  assert.ok(payload.length > 10);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('disconnect did not settle')), 3000);
    const req = httpRequest(url, {
      method: 'POST',
      agent: false,
      headers: { authorization, 'content-type': 'application/json', 'content-length': String(payload.length) },
    }, () => {});
    req.on('error', () => { clearTimeout(timer); resolve(); });
    req.write(payload.subarray(0, 10));
    setTimeout(() => req.destroy(), 150);
  });
}

function postAbortDuringBody(url: string, authorization: string, body: string, abortDuringBody: () => Promise<void>): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(body);
  assert.ok(payload.length > 10);
  return new Promise((resolve, reject) => {
    let phase: 'reading' | 'cancelled' | 'done' = 'reading';
    const finish = (error?: Error, response?: { status: number; body: string }) => {
      if (phase === 'done') return;
      phase = 'done';
      if (error) reject(error);
      else resolve(response!);
    };
    const req = httpRequest(url, {
      method: 'POST',
      agent: false,
      headers: { authorization, 'content-type': 'application/json', 'content-length': String(payload.length) },
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        if (phase !== 'cancelled') finish(new Error('response completed before the in-body cancellation'));
        else finish(undefined, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', error => finish(error));
    req.write(payload.subarray(0, 10));
    setTimeout(() => {
      if (phase !== 'reading') return;
      abortDuringBody().then(() => {
        if (phase !== 'reading') return;
        phase = 'cancelled';
        req.end(payload.subarray(10));
      }, error => finish(error));
    }, 150);
  });
}

describe('request admission HTTP lifecycle', () => {
  test('a completed control check still allows, then a partial disconnect leaves the process able to allow the next check', { timeout: 20_000 }, async () => {
    const fixture = await startFixture();
    try {
      const { authorization, controlUrl } = fixture.ready;
      const first = await post(controlUrl, authorization, controlBody(1));
      assert.equal(first.status, 200);
      assert.deepEqual(JSON.parse(first.body), { decision: 'allow', requestSequence: 1, policyEpoch: 1, hostGeneration: 1 });
      await disconnectDuringBody(controlUrl, authorization, controlBody(2));
      await assertStaysAlive(fixture);
      const second = await post(controlUrl, authorization, controlBody(2));
      assert.equal(second.status, 200);
      assert.deepEqual(JSON.parse(second.body), { decision: 'allow', requestSequence: 2, policyEpoch: 1, hostGeneration: 1 });
      const stats = await fixture.command('stats');
      assert.equal(stats.checks, 2);
      assert.equal(stats.calls, 0);
      assert.equal(stats.aborted, false);
    } finally { await stopFixture(fixture); }
  });

  test('a completed tools/list still responds, then a partial disconnect leaves the process able to list tools again', { timeout: 20_000 }, async () => {
    const fixture = await startFixture();
    try {
      const { authorization, mcpUrl } = fixture.ready;
      const first = await post(mcpUrl, authorization, mcpList());
      assert.equal(first.status, 200);
      const catalog = JSON.parse(first.body) as { result: { tools: Array<{ name: string }> } };
      assert.deepEqual(catalog.result.tools.map(tool => tool.name), ['probe_write']);
      assert.equal(JSON.stringify(catalog).includes('request-check'), false);
      await disconnectDuringBody(mcpUrl, authorization, mcpCall());
      await assertStaysAlive(fixture);
      const second = await post(mcpUrl, authorization, mcpList());
      assert.equal(second.status, 200);
      const again = JSON.parse(second.body) as { result: { tools: Array<{ name: string }> } };
      assert.deepEqual(again.result.tools.map(tool => tool.name), ['probe_write']);
      assert.equal(JSON.stringify(again).includes('request-check'), false);
      const stats = await fixture.command('stats');
      assert.equal(stats.checks, 0);
      assert.equal(stats.calls, 0);
    } finally { await stopFixture(fixture); }
  });

  test('aborting during a control body does not allow or check after the remainder arrives', { timeout: 20_000 }, async () => {
    const fixture = await startFixture();
    try {
      const { authorization, controlUrl } = fixture.ready;
      const response = await postAbortDuringBody(controlUrl, authorization, controlBody(1), async () => {
        const ack = await fixture.command('abort');
        assert.equal(ack.aborted, true);
        assert.equal(ack.checks, 0);
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.includes('allow'), false);
      const stats = await fixture.command('stats');
      assert.equal(stats.checks, 0);
      assert.equal(stats.aborted, true);
      const later = await post(controlUrl, authorization, controlBody(1));
      assert.equal(later.status, 403);
      const after = await fixture.command('stats');
      assert.equal(after.checks, 0);
      assert.equal(after.calls, 0);
      assertNoProcessFault(fixture.stderr);
    } finally { await stopFixture(fixture); }
  });

  test('aborting during an mcp body does not dispatch after the remainder arrives', { timeout: 20_000 }, async () => {
    const fixture = await startFixture();
    try {
      const { authorization, mcpUrl } = fixture.ready;
      const response = await postAbortDuringBody(mcpUrl, authorization, mcpCall(), async () => {
        const ack = await fixture.command('abort');
        assert.equal(ack.aborted, true);
        assert.equal(ack.calls, 0);
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.includes('probe_write'), false);
      const stats = await fixture.command('stats');
      assert.equal(stats.calls, 0);
      assert.equal(stats.checks, 0);
      const later = await post(mcpUrl, authorization, mcpList());
      assert.equal(later.status, 403);
      const after = await fixture.command('stats');
      assert.equal(after.calls, 0);
      assertNoProcessFault(fixture.stderr);
    } finally { await stopFixture(fixture); }
  });
});
