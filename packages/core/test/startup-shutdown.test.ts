import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const peer = fileURLToPath(new URL('./engine-fixture.mjs', import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function stopDuringSetup(stage: 'inspection' | 'preparation'): Promise<{
  stopped: boolean; output: string; databaseCreated: boolean; lockPresent: boolean;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-startup-shutdown-'));
  const database = join(directory, 'state.sqlite');
  const dshHome = join(directory, 'home');
  const workspace = join(directory, 'workspace');
  const port = await freePort();
  // Delay a real awaited filesystem call, then use the real entry-point handler.
  // No runtime is launched and no model or external account is contacted.
  const bootstrap = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const operation = ${JSON.stringify(stage === 'inspection' ? 'stat' : 'writeFile')};
    const original = fs.promises[operation]; let stopped = false;
    fs.promises[operation] = async (...args) => {
      const target = String(args[0]);
      const selected = operation === 'stat' ? target === process.execPath : target.endsWith('kleio-model.patch.json');
      if (selected && !stopped) {
        stopped = true; console.log('PROBE_STOP_DURING_SETUP'); process.emit('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 50));
        if (operation === 'writeFile') console.log('PROBE_LOCK_HELD_WHILE_WRITE_PENDING:' + fs.existsSync(process.env.AGENT_DATABASE + '.lock'));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return original(...args);
    };
    syncBuiltinESMExports(); await import('./apps/server/index.ts');`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP, TMP: process.env.TMP,
    AGENT_ENGINE: stage === 'inspection' ? 'demo' : 'dsh', AGENT_DATABASE: database, AGENT_PORT: String(port),
    DSH_COMMAND: process.execPath, DSH_ARGS_JSON: JSON.stringify([peer]), DSH_HOME: dshHome, DSH_WORKSPACE: workspace,
    KLEIO_MODEL_BASE_URL: 'http://127.0.0.1:12345/v1', KLEIO_MODEL_ID: 'test-model',
    KLEIO_MODEL_API_KEY: 'isolated-startup-test-placeholder',
  };
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', bootstrap], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); }); child.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopped = await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 3_000); })]);
    return { stopped, output, databaseCreated: existsSync(database), lockPresent: existsSync(database + '.lock') };
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    // Only exact, isolated fixture files and empty directories are removed.
    for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true });
    rmSync(join(dshHome, 'kleio-model.patch.json'), { force: true });
    if (existsSync(database + '.lock')) rmdirSync(database + '.lock');
    for (const emptyDirectory of [dshHome, workspace]) if (existsSync(emptyDirectory)) rmdirSync(emptyDirectory);
    rmdirSync(directory);
  }
}

test('a shutdown during setup inspection cannot subsequently open the database or start listening', async () => {
  const result = await stopDuringSetup('inspection');
  assert.match(result.output, /PROBE_STOP_DURING_SETUP/);
  assert.equal(result.stopped, true, 'Startup must finish shutdown instead of leaving a live listener');
  assert.equal(result.databaseCreated, false, 'The stopped startup must not create or recover durable state');
  assert.equal(result.lockPresent, false);
  assert.doesNotMatch(result.output, /Personal Agent 内核服务/);
});

test('a shutdown during launch preparation retains ownership until its pending write is finished', async () => {
  const result = await stopDuringSetup('preparation');
  assert.match(result.output, /PROBE_STOP_DURING_SETUP/);
  assert.match(result.output, /PROBE_LOCK_HELD_WHILE_WRITE_PENDING:true/);
  assert.equal(result.stopped, true);
  assert.equal(result.databaseCreated, false);
  assert.equal(result.lockPresent, false);
  assert.doesNotMatch(result.output, /Personal Agent 内核服务/);
});
