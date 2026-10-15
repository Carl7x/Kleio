import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireOwnership, CoreError } from '../ownership.ts';

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

test('a compromised owner rejects further use and never removes the replacement owner lock', async t => {
  const fixture = databaseFixture(t);
  let lostResolve: ((error: CoreError) => void) | undefined;
  const lost = new Promise<CoreError>(resolve => { lostResolve = resolve; });
  const first = await acquireOwnership(fixture.file, error => lostResolve?.(error)); fixture.cleanup(() => first.release());
  assert.equal(dirname(first.databasePath), realpathSync(dirname(fixture.file)));
  rmdirSync(first.databasePath + '.lock');
  assert.equal((await bounded(lost)).code, 'ownership_lost');
  assert.throws(() => first.assertHeld(), error => error instanceof CoreError && error.code === 'ownership_lost');
  const next = await acquireOwnership(fixture.file, () => assert.fail('Replacement owner lost its lock')); fixture.cleanup(() => next.release());
  await first.release(); await first.release();
  assert.equal(existsSync(next.databasePath + '.lock'), true); next.assertHeld();
});
