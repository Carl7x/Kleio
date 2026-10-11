import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { inspectDshSetup, prepareDshLaunch, DshSetupError } from '../src/setup.ts';

async function temporary(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kleio-dsh-setup-'));
  const expectedParent = resolve(tmpdir());
  t.after(async () => {
    const target = resolve(directory);
    if (!target.startsWith(`${expectedParent}${sep}`) || !relative(expectedParent, target).startsWith('kleio-dsh-setup-')) throw new Error('Refused cleanup outside the isolated test directory');
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

function configured(directory: string): NodeJS.ProcessEnv {
  return {
    DSH_COMMAND: process.execPath,
    DSH_ARGS_JSON: JSON.stringify([resolve('packages/harness-dsh/test/acp-fixture.mjs'), '--profile', 'acp']),
    DSH_HOME: join(directory, 'home'), DSH_WORKSPACE: join(directory, 'workspace'),
    KLEIO_MODEL_BASE_URL: 'http://127.0.0.1:12345/v1', KLEIO_MODEL_ID: 'test-model',
    KLEIO_MODEL_API_KEY: 'private-placeholder-never-return-to-ui',
    UNRELATED_ACCOUNT_TOKEN: 'unrelated-private-token',
    TZ: 'Asia/Shanghai',
    PATH: process.env.PATH,
  };
}

test('inspection explains missing setup without writing files or exposing configuration', async t => {
  const directory = await temporary(t);
  const env = configured(directory);
  delete env.KLEIO_MODEL_API_KEY;
  const result = await inspectDshSetup(env, { baseDir: process.cwd() });
  assert.equal(result.status, 'missing');
  assert.equal(result.checks.find(check => check.id === 'credential')?.status, 'missing');
  assert.deepEqual(await readdir(directory), []);
  assert(!JSON.stringify(result).includes(env.KLEIO_MODEL_BASE_URL!));
  assert(!JSON.stringify(result).includes('unrelated-private-token'));
  await assert.rejects(prepareDshLaunch(env, { baseDir: process.cwd() }), DshSetupError);
});

test('a launch plan uses the private profile and routes only the selected credential', async t => {
  const directory = await temporary(t);
  const env = configured(directory);
  const result = await inspectDshSetup(env, { baseDir: process.cwd() });
  assert.equal(result.status, 'ready');
  assert(!JSON.stringify(result).includes(env.KLEIO_MODEL_API_KEY!));
  const plan = await prepareDshLaunch(env, { baseDir: process.cwd() });
  assert.equal(plan.command, process.execPath);
  assert.equal(plan.cwd, env.DSH_WORKSPACE);
  assert.deepEqual(plan.args.slice(1, 5), ['--profile', 'kleio', '--from-default-profile', 'acp']);
  assert.equal(plan.env.DSH_HOME, env.DSH_HOME);
  assert.equal(plan.env.KLEIO_MODEL_API_KEY, env.KLEIO_MODEL_API_KEY);
  assert.equal(plan.env.UNRELATED_ACCOUNT_TOKEN, undefined);
  assert.equal(plan.env.DSH_PERMISSION_MODE, 'read-only');
  assert.equal(plan.env.DSH_TELEMETRY_DISABLED, '1');
  assert.equal(plan.env.TZ, 'Asia/Shanghai');
  const generated = await readFile(plan.args.at(-1)!, 'utf8');
  assert(!generated.includes(env.KLEIO_MODEL_API_KEY!));
  const overlay = JSON.parse(generated) as Array<{ id: string; config: unknown }>;
  assert.equal(overlay[0]?.id, 'llm-pi-ai');
  assert(generated.includes('"apiKeyEnv": "KLEIO_MODEL_API_KEY"'));
  const presentOverlay = await readFile(plan.args.at(-3)!, 'utf8');
  assert(presentOverlay.includes('@deepseek-ai/dsh-tool-present'));
});

test('invalid launchers and model metadata remain missing rather than producing a launch plan', async t => {
  const directory = await temporary(t);
  for (const override of [
    { DSH_ARGS_JSON: '["--profile","web"]' },
    { DSH_ARGS_JSON: 'not-json' },
    { DSH_ARGS_JSON: '[]' },
    { KLEIO_MODEL_BASE_URL: 'https://user:secret@gateway.example/v1' },
    { KLEIO_MODEL_BASE_URL: 'https://gateway.example/v1?api_key=private' },
    { KLEIO_MODEL_MAX_TOKENS: '999999999' },
    { KLEIO_MODEL_API_KEY_ENV: 'invalid-key-name' },
    { KLEIO_MODEL_API_KEY_ENV: 'DSH_HOME' },
  ]) {
    const env = { ...configured(directory), ...override };
    const result = await inspectDshSetup(env, { baseDir: process.cwd() });
    assert.equal(result.status, 'missing');
    await assert.rejects(prepareDshLaunch(env, { baseDir: process.cwd() }), DshSetupError);
    assert(!JSON.stringify(result).includes('user:secret'));
    assert(!JSON.stringify(result).includes('api_key=private'));
  }
});

test('relative product paths resolve from baseDir and a custom credential reference stays private', async t => {
  const directory = await temporary(t);
  const env = {
    ...configured(directory), DSH_HOME: 'private-home', DSH_WORKSPACE: 'private-workspace',
    KLEIO_MODEL_API_KEY_ENV: 'LOCAL_MODEL_TOKEN', LOCAL_MODEL_TOKEN: 'specific-model-secret',
  };
  const plan = await prepareDshLaunch(env, { baseDir: directory });
  assert.equal(plan.env.DSH_HOME, join(directory, 'private-home'));
  assert.equal(plan.cwd, join(directory, 'private-workspace'));
  assert.equal(plan.env.LOCAL_MODEL_TOKEN, 'specific-model-secret');
  assert.equal(plan.env.KLEIO_MODEL_API_KEY, undefined);
  assert(!(await readFile(plan.args.at(-1)!, 'utf8')).includes('specific-model-secret'));
});

test('an initialized private profile is reused without the one-time template flag', async t => {
  const directory = await temporary(t);
  const env = configured(directory);
  const profile = join(env.DSH_HOME!, 'profiles/kleio');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-kleio', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } } }));
  const plan = await prepareDshLaunch(env, { baseDir: process.cwd() });
  assert(!plan.args.includes('--from-default-profile'));
  assert.deepEqual(plan.args.slice(1, 3), ['--profile', 'kleio']);
  assert.equal(plan.args.filter(argument => argument === '--patch').length, 2);
});

const installedCli = resolve('packages/harness-dsh/.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
test('the pinned installed dsh composes the kleio profile and explicit present without a model call', { skip: !existsSync(installedCli), timeout: 30_000 }, async t => {
  const directory = await temporary(t);
  const env: NodeJS.ProcessEnv = { ...configured(directory), DSH_ARGS_JSON: JSON.stringify([installedCli]) };
  const plan = await prepareDshLaunch(env, { baseDir: process.cwd() });
  const result = spawnSync(plan.command, [...plan.args, '--dump-config'], { cwd: plan.cwd, env: plan.env, encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.equal(result.status, 0, 'The published dsh profile must compose successfully');
  assert.match(result.stdout, /id: kleio-present/);
  assert.match(result.stdout, /@deepseek-ai\/dsh-tool-present/);
  assert.match(result.stdout, /kleio-model/);
  assert.match(result.stdout, /apiKeyEnv: KLEIO_MODEL_API_KEY/);
  assert(!result.stdout.includes(env.KLEIO_MODEL_API_KEY!));
  const manifest = JSON.parse(await readFile(join(plan.env.DSH_HOME!, 'profiles/kleio/package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } };
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']);
  const restartedPlan = await prepareDshLaunch(env, { baseDir: process.cwd() });
  assert(!restartedPlan.args.includes('--from-default-profile'));
  const restarted = spawnSync(restartedPlan.command, [...restartedPlan.args, '--dump-config'], { cwd: restartedPlan.cwd, env: restartedPlan.env, encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.equal(restarted.status, 0, 'The initialized published profile must compose again without being recreated');
  assert.match(restarted.stdout, /id: kleio-present/);
});
