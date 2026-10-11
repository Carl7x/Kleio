import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireOwnership } from '../ownership.ts';
import { AgentStore } from '../store.ts';
import { CoreError } from '../contracts.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function databaseFixture(t: TestContext): { file: string; cleanup(operation: () => void | Promise<void>): void } {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-ownership-'));
  const file = join(directory, 'state.sqlite');
  const operations: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    for (const operation of operations.reverse()) await operation();
    // These are known files and empty lock directories, never recursive targets.
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    if (existsSync(file + '.lock')) rmdirSync(file + '.lock');
    rmdirSync(directory);
  });
  return { file, cleanup: operation => { operations.push(operation); } };
}

async function bounded<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for the local test process')), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function startLocalServer(database: string, port: number): {
  ready(): Promise<void>; stop(): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  diagnostics(): string;
} {
  // IPC asks the entry point to run its real signal handler on Windows as well.
  const bootstrap = `process.on('message', message => { if (message === 'stop') process.emit('SIGTERM'); });
    await import('./apps/server/index.ts'); process.channel?.unref();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', bootstrap], {
    cwd: root, env: { ...process.env, AGENT_ENGINE: 'demo', AGENT_DATABASE: database, AGENT_PORT: String(port) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  let stdout = '';
  let readyResolve: (() => void) | undefined;
  const listening = new Promise<void>(resolve => { readyResolve = resolve; });
  const output = child.stdout; const errors = child.stderr;
  assert.ok(output && errors);
  output.setEncoding('utf8'); errors.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('Personal Agent 内核服务：')) readyResolve?.();
  });
  errors.on('data', (chunk: string) => { diagnostics += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    async ready() {
      await bounded(Promise.race([listening, exited.then(() => { throw new Error('Server exited before listening: ' + diagnostics); })]));
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send('stop');
        try { await bounded(exited, 3_000); }
        catch { child.kill(); await bounded(exited); }
      }
    },
    exited, diagnostics: () => diagnostics,
  };
}

async function waitingApproval(base: string): Promise<{ runId: string; approvalId: string }> {
  const response = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '验证审批：等待用户决定' }) });
  assert.equal(response.status, 202);
  const submitted = await response.json() as { runId: string };
  for (let i = 0; i < 200; i++) {
    const approvals = await (await fetch(base + '/api/approvals')).json() as Array<{ id: string; runId: string; status: string }>;
    const approval = approvals.find(item => item.runId === submitted.runId && item.status === 'pending');
    if (approval) return { runId: submitted.runId, approvalId: approval.id };
    await delay(5);
  }
  throw new Error('Demo did not reach its approval wait');
}

test('a second entry-point instance cannot recover the first owner; graceful shutdown releases ownership', async t => {
  const fixture = databaseFixture(t); const port = await freePort();
  const first = startLocalServer(fixture.file, port); fixture.cleanup(() => first.stop()); await first.ready();
  const base = 'http://127.0.0.1:' + port; const pending = await waitingApproval(base);
  const second = startLocalServer(fixture.file, port); fixture.cleanup(() => second.stop());
  assert.equal((await bounded(second.exited)).code, 1);
  assert.match(second.diagnostics(), /此数据库已有运行中的服务/);
  const runs = await (await fetch(base + '/api/runs')).json() as Array<{ id: string; status: string }>;
  const approvals = await (await fetch(base + '/api/approvals')).json() as Array<{ id: string; status: string }>;
  assert.equal(runs.find(run => run.id === pending.runId)?.status, 'waiting_approval');
  assert.equal(approvals.find(approval => approval.id === pending.approvalId)?.status, 'pending');
  await first.stop(); assert.equal((await first.exited).code, 0);
  assert.equal(existsSync(fixture.file + '.lock'), false);
  const next = await acquireOwnership(fixture.file, () => assert.fail('Fresh owner lost its lock'));
  fixture.cleanup(() => next.release());
  const store = new AgentStore(next.databasePath); fixture.cleanup(() => store.close());
  assert.equal(store.run(pending.runId).status, 'interrupted');
  assert.equal(store.approvals().find(approval => approval.id === pending.approvalId)?.status, 'interrupted');
});

test('the live entry point stops execution and closes the database when its lock is compromised', async t => {
  const fixture = databaseFixture(t); const port = await freePort();
  const server = startLocalServer(fixture.file, port); fixture.cleanup(() => server.stop()); await server.ready();
  const pending = await waitingApproval('http://127.0.0.1:' + port);
  rmdirSync(fixture.file + '.lock');
  assert.equal((await bounded(server.exited)).code, 1);
  assert.match(server.diagnostics(), /服务独占锁已失效/);
  const next = await acquireOwnership(fixture.file, () => assert.fail('Replacement owner lost its lock'));
  fixture.cleanup(() => next.release());
  const store = new AgentStore(next.databasePath); fixture.cleanup(() => store.close());
  assert.equal(store.run(pending.runId).status, 'interrupted');
  assert.equal(store.approvals().find(approval => approval.id === pending.approvalId)?.status, 'interrupted');
});

test('a compromised owner rejects further use and never removes the replacement owner lock', async t => {
  const fixture = databaseFixture(t);
  let lostResolve: ((error: CoreError) => void) | undefined;
  const lost = new Promise<CoreError>(resolve => { lostResolve = resolve; });
  const first = await acquireOwnership(fixture.file, error => lostResolve?.(error)); fixture.cleanup(() => first.release());
  assert.equal(dirname(first.databasePath), dirname(fixture.file));
  rmdirSync(first.databasePath + '.lock');
  assert.equal((await bounded(lost)).code, 'ownership_lost');
  assert.throws(() => first.assertHeld(), error => error instanceof CoreError && error.code === 'ownership_lost');
  const next = await acquireOwnership(fixture.file, () => assert.fail('Replacement owner lost its lock')); fixture.cleanup(() => next.release());
  await first.release(); await first.release();
  assert.equal(existsSync(next.databasePath + '.lock'), true); next.assertHeld();
});
