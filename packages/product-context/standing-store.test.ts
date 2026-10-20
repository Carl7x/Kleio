import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_SCOPE_ID } from '../context-contracts/context.ts';
import type { StandingSnapshotV1 } from '../context-contracts/context.ts';
import type { StrictBoundedRead } from './files.ts';
import { ensureStanding, loadStanding, STANDING_TEMPLATES, writeIdentityFields } from './index.ts';
import {
  STANDING_FILES, STANDING_LIMIT, StandingStoreError, type StandingName,
} from './standing-source.ts';
import { StandingStore, type StandingFileReader } from './standing-store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function tempDir(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-g33-'));
  t.after(() => { rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

function absentDir(t: TestContext): string {
  const directory = join(tmpdir(), `kleio-g33-absent-${randomBytes(6).toString('hex')}`);
  t.after(() => { rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

function assertCode(error: unknown, code: StandingStoreError['code'], secrets: readonly string[] = []): boolean {
  assert.ok(error instanceof StandingStoreError);
  assert.equal(error.code, code);
  assert.equal(error.message.startsWith(`${code}:`), true);
  for (const secret of secrets) assert.equal(error.message.includes(secret), false);
  return true;
}

function assertSafe(value: unknown, secrets: readonly string[]): void {
  const encoded = JSON.stringify(value);
  for (const secret of secrets) assert.equal(encoded.includes(secret), false);
}

function marked(name: StandingName, marker: string): string {
  if (name === 'IDENTITY.md') return `# Identity\n\n- Name: ${marker}\n- Tone: concise\n`;
  return `# ${name}\n\n${marker}\n`;
}

function okBody(name: StandingName, marker: string): StrictBoundedRead {
  const text = marked(name, marker);
  return { ok: true, text, byteLength: Buffer.byteLength(text) };
}

function scripted(plan: (call: number, name: StandingName) => StrictBoundedRead): {
  readFile: StandingFileReader;
  seen: StandingName[];
  calls: () => number;
} {
  const seen: StandingName[] = [];
  let callCount = 0;
  const readFile: StandingFileReader = name => {
    callCount += 1;
    seen.push(name);
    return plan(callCount, name);
  };
  return { readFile, seen, calls: () => callCount };
}

function repeatNames(times: number): StandingName[] {
  const names: StandingName[] = [];
  for (let index = 0; index < times; index += 1) names.push(...STANDING_FILES);
  return names;
}

function countName(seen: readonly StandingName[], name: StandingName): number {
  return seen.filter(item => item === name).length;
}

describe('G3.3 standing snapshots', () => {
  test('constructor stores config and does not read or create a missing root', t => {
    const directory = absentDir(t);
    let calls = 0;
    const store = new StandingStore({
      dataDirectory: directory,
      scopeId: 'local',
      readFile: () => { calls += 1; throw new Error(`SECRET_EARLY ${directory}`); },
    });
    assert.equal(existsSync(directory), false);
    assert.equal(calls, 0);
    assert.equal(store instanceof StandingStore, true);
  });

  test('capture freezes the scope copied before the source read', t => {
    const directory = tempDir(t);
    const scope = {
      scopeId: 'local',
      executionId: 'exec-original',
      conversationId: 'conv-original',
      workId: 'work-original',
    };
    const store = new StandingStore({
      dataDirectory: directory,
      scopeId: 'local',
      readFile(name) {
        scope.scopeId = 'changed-in-source-callback';
        scope.executionId = 'exec-changed';
        scope.conversationId = 'conv-changed';
        scope.workId = 'work-changed';
        return okBody(name, 'River');
      },
    });
    const part = store.capture(scope);
    assert.equal(part.scope.scopeId, 'local');
    assert.equal(part.scope.executionId, 'exec-original');
    assert.equal(part.scope.conversationId, 'conv-original');
    assert.equal(part.scope.workId, 'work-original');
    assert.equal(part.content.scopeId, part.scope.scopeId);
    assert.equal(part.content.name, 'River');
    assert.equal(Object.isFrozen(scope), false);
    assert.equal(Object.isFrozen(part.scope), true);
    assert.equal(scope.scopeId, 'changed-in-source-callback');
    assert.equal(scope.executionId, 'exec-changed');
    assert.throws(() => { (part.scope as { executionId: string }).executionId = 'later'; });
  });

  test('invalid scope input is a mismatch before any standing IO', t => {
    const directory = absentDir(t);
    let calls = 0;
    const store = new StandingStore({
      dataDirectory: directory,
      scopeId: 'local',
      readFile() {
        calls += 1;
        return { ok: false, reason: 'missing', byteLength: 0 };
      },
    });
    const invalid: unknown[] = [null, undefined, 'local', 1, { scopeId: 'local' }, { scopeId: 'local', executionId: 4 }];
    for (const input of invalid) {
      assert.throws(
        () => store.capture(input as never),
        (error: unknown) => assertCode(error, 'CONTEXT_SCOPE_MISMATCH', [directory]),
      );
    }
    assert.equal(calls, 0);
    assert.equal(existsSync(directory), false);
  });

  test('a foreign scope is refused before any standing IO', t => {
    const directory = absentDir(t);
    const script = scripted(() => ({ ok: false, reason: 'missing', byteLength: 0 }));
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: script.readFile });
    assert.throws(
      () => store.capture({ scopeId: directory, executionId: 'exec-foreign' }),
      (error: unknown) => assertCode(error, 'CONTEXT_SCOPE_MISMATCH', [directory, 'exec-foreign']),
    );
    assert.equal(script.calls(), 0);
    assert.equal(existsSync(directory), false);
  });

  test('a matching scope initializes a missing root and a bad root stays a fixed error', t => {
    const missing = absentDir(t);
    const created = new StandingStore({ dataDirectory: missing, scopeId: 'local' });
    assert.equal(existsSync(missing), false);
    const snapshot = created.read();
    assert.equal(existsSync(join(missing, 'standing', 'IDENTITY.md')), true);
    assert.equal(snapshot.scopeId, 'local');
    assert.equal(snapshot.name, 'Kleio');
    assert.equal(snapshot.files[0]?.text, STANDING_TEMPLATES['IDENTITY.md']);

    const parent = tempDir(t);
    const blocker = join(parent, 'not-a-directory');
    writeFileSync(blocker, 'ROOT_SENTINEL');
    let calls = 0;
    const blocked = new StandingStore({
      dataDirectory: blocker,
      scopeId: 'local',
      readFile: () => { calls += 1; return okBody('IDENTITY.md', 'River'); },
    });
    assert.throws(() => blocked.read(), (error: unknown) => assertCode(error, 'STANDING_UNAVAILABLE', [blocker, 'ROOT_SENTINEL']));
    assert.throws(
      () => blocked.capture({ scopeId: 'local', executionId: 'exec-1' }),
      (error: unknown) => assertCode(error, 'STANDING_UNAVAILABLE', [blocker, 'ROOT_SENTINEL']),
    );
    assert.throws(() => loadStanding(blocker), (error: unknown) => assertCode(error, 'STANDING_UNAVAILABLE', [blocker]));
    assert.throws(() => ensureStanding(blocker), (error: unknown) => assertCode(error, 'STANDING_UNAVAILABLE', [blocker]));
    assert.equal(calls, 0);
    assert.equal(readFileSync(blocker, 'utf8'), 'ROOT_SENTINEL');
  });

  test('fresh files publish defaults, and the same bytes keep one version across ids, directories, and scopes', t => {
    const left = tempDir(t);
    const right = tempDir(t);
    const store = new StandingStore({ dataDirectory: left, scopeId: LOCAL_SCOPE_ID });
    const first = store.read();
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.scopeId, 'local');
    assert.match(first.snapshotId, UUID);
    assert.match(first.sourceVersion, /^[0-9a-f]{64}$/);
    assert.equal(first.name, 'Kleio');
    assert.equal(first.tone, 'warm');
    assert.equal(first.nameDetail, 'from standing/IDENTITY.md');
    assert.equal(first.toneDetail, 'from standing/IDENTITY.md');
    assert.equal(first.defaultTemplate, true);
    assert.deepEqual([...first.problems], []);
    assert.equal(Object.hasOwn(first, 'tools'), false);
    assert.equal(Object.hasOwn(first, 'estimatedTokens'), false);
    assert.deepEqual(first.files.map(file => file.name), [...STANDING_FILES]);
    for (const file of first.files) {
      assert.equal(file.status, 'loaded');
      assert.equal(file.detail, `${file.name} loaded.`);
      assert.equal(file.text, STANDING_TEMPLATES[file.name]);
      assert.equal(file.byteLength, Buffer.byteLength(file.text));
      assert.notEqual(file.sourceVersion, first.sourceVersion);
    }
    const second = store.read();
    assert.equal(second.sourceVersion, first.sourceVersion);
    assert.notEqual(second.snapshotId, first.snapshotId);
    const otherDirectory = new StandingStore({ dataDirectory: right, scopeId: 'local' }).read();
    const otherScope = new StandingStore({ dataDirectory: left, scopeId: 'desk' }).read();
    assert.equal(otherDirectory.sourceVersion, first.sourceVersion);
    assert.equal(otherScope.sourceVersion, first.sourceVersion);
    assert.equal(otherScope.scopeId, 'desk');
    assert.notEqual(otherScope.snapshotId, first.snapshotId);
    assertSafe(first, [left, right]);

    const legacy = loadStanding(left);
    const third = new StandingStore({ dataDirectory: left, scopeId: LOCAL_SCOPE_ID }).read();
    assert.equal(legacy.name, third.name);
    assert.equal(legacy.tone, third.tone);
    assert.equal(legacy.nameDetail, third.nameDetail);
    assert.equal(legacy.toneDetail, third.toneDetail);
    assert.equal(legacy.defaultTemplate, third.defaultTemplate);
    assert.deepEqual(legacy.problems, [...third.problems]);
    assert.deepEqual(
      legacy.files.map(file => [file.name, file.status, file.text, file.detail]),
      third.files.map(file => [file.name, file.status, file.text, file.detail]),
    );
    assert.equal(third.sourceVersion, first.sourceVersion);
  });

  test('each file changes the version, and mtime alone does not', t => {
    const directory = tempDir(t);
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local' });
    const created = store.read();
    const soul = join(directory, 'standing', 'SOUL.md');
    const beforeTouch = lstatSync(soul);
    utimesSync(soul, beforeTouch.atime, new Date(beforeTouch.mtimeMs + 60_000));
    const touched = store.read();
    assert.notEqual(lstatSync(soul).mtimeMs, beforeTouch.mtimeMs);
    assert.equal(touched.sourceVersion, created.sourceVersion);
    assert.notEqual(touched.snapshotId, created.snapshotId);
    assert.equal(touched.files[1]?.sourceVersion, created.files[1]?.sourceVersion);

    let previous = touched;
    for (const name of STANDING_FILES) {
      const path = join(directory, 'standing', name);
      if (name === 'IDENTITY.md') writeFileSync(path, '# Identity\n\n- Name: Nia\n- Tone: concise\n');
      else writeFileSync(path, `# ${name}\n\nmarker ${name}\n`);
      const next = store.read();
      assert.notEqual(next.sourceVersion, previous.sourceVersion);
      assert.notEqual(next.snapshotId, previous.snapshotId);
      const changed = next.files.find(file => file.name === name);
      const prior = previous.files.find(file => file.name === name);
      assert.ok(changed && prior);
      assert.notEqual(changed.sourceVersion, prior.sourceVersion);
      assert.equal(changed.text.includes(name === 'IDENTITY.md' ? 'Nia' : `marker ${name}`), true);
      for (const other of STANDING_FILES) {
        if (other === name) continue;
        assert.equal(
          next.files.find(file => file.name === other)?.sourceVersion,
          previous.files.find(file => file.name === other)?.sourceVersion,
        );
      }
      previous = next;
    }
    assert.equal(previous.name, 'Nia');
    assert.equal(previous.tone, 'concise');
    assert.equal(previous.defaultTemplate, false);
  });

  test('published parts are deep-frozen copies and stay fixed after later disk edits', t => {
    const directory = tempDir(t);
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local' });
    const extra = { secret: directory };
    const scope = { scopeId: 'local', executionId: 'exec-1', conversationId: 'conv-1', workId: 'work-1', extra };
    const part = store.capture(scope);
    assert.equal(Object.isFrozen(scope), false);
    assert.equal(Object.isFrozen(extra), false);
    assert.equal(Object.isFrozen(STANDING_TEMPLATES), false);
    scope.executionId = 'changed';
    scope.conversationId = 'changed-conv';
    assert.equal(part.schemaVersion, 1);
    assert.equal(part.kind, 'standing');
    assert.equal(part.authority, 'user-config');
    assert.equal(part.sourceRef, 'standing');
    assert.equal(part.required, true);
    assert.equal(part.id, part.content.snapshotId);
    assert.equal(part.sourceVersion, part.content.sourceVersion);
    assert.equal(part.scope.scopeId, 'local');
    assert.equal(part.scope.executionId, 'exec-1');
    assert.equal(part.scope.conversationId, 'conv-1');
    assert.equal(part.scope.workId, 'work-1');
    assert.equal('extra' in part.scope, false);
    assert.equal(Object.hasOwn(part, 'tools'), false);
    assert.equal(Object.hasOwn(part.content, 'estimatedTokens'), false);
    assert.equal(Object.isFrozen(part), true);
    assert.equal(Object.isFrozen(part.scope), true);
    assert.equal(Object.isFrozen(part.content), true);
    assert.equal(Object.isFrozen(part.content.files), true);
    assert.equal(Object.isFrozen(part.content.problems), true);
    for (const file of part.content.files) assert.equal(Object.isFrozen(file), true);
    assert.throws(() => { (part.content as { name: string }).name = 'nope'; });
    assert.throws(() => { (part.content.files[0] as { text: string }).text = 'nope'; });
    assert.throws(() => { (part.content.problems as string[]).push('nope'); });
    assert.throws(() => { (part.scope as { executionId: string }).executionId = 'nope'; });
    const bare = store.capture({ scopeId: 'local', executionId: 'exec-2' });
    assert.equal(Object.hasOwn(bare.scope, 'conversationId'), false);
    assert.equal(Object.hasOwn(bare.scope, 'workId'), false);

    const identity = join(directory, 'standing', 'IDENTITY.md');
    const held = part.content;
    writeFileSync(identity, '# Identity\n\n- Name: 文件名\n- Tone: warm\n');
    const reread = store.read();
    assert.equal(reread.name, '文件名');
    assert.equal(held.name, 'Kleio');
    assert.match(held.files[0]?.text ?? '', /- Name: Kleio/);
    assert.notEqual(reread.sourceVersion, held.sourceVersion);
    rmSync(directory, { recursive: true, force: true });
    assert.equal(held.name, 'Kleio');
    assert.match(held.files[0]?.text ?? '', /- Name: Kleio/);
    assert.equal(held.files[1]?.text, STANDING_TEMPLATES['SOUL.md']);
  });

  test('a stable collection is two full passes and later property access does not read again', t => {
    const directory = tempDir(t);
    const script = scripted((_call, name) => okBody(name, 'River'));
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: script.readFile });
    const snapshot = store.read();
    const afterRead = script.calls();
    assert.equal(snapshot.name, 'River');
    assert.equal(snapshot.tone, 'concise');
    assert.equal(snapshot.defaultTemplate, false);
    assert.equal(snapshot.nameDetail, 'from standing/IDENTITY.md');
    for (const file of snapshot.files) assert.match(file.text, /River/);
    snapshot.files[0]?.text;
    snapshot.files[4]?.detail;
    snapshot.problems.join('');
    snapshot.sourceVersion;
    snapshot.name;
    assert.equal(script.calls(), afterRead);
    assert.equal(script.calls(), 10);
    assert.deepEqual(script.seen, repeatNames(2));
    assert.match(readFileSync(join(directory, 'standing', 'IDENTITY.md'), 'utf8'), /- Name: Kleio/);
    assert.equal(snapshot.files[1]?.text === STANDING_TEMPLATES['SOUL.md'], false);
    assert.equal(Object.isFrozen(snapshot), true);
  });

  test('a mismatched pass retries the whole set once and publishes only the stable attempt', t => {
    const directory = tempDir(t);
    const script = scripted((call, name) => {
      if (call === 1) rmSync(join(directory, 'standing', 'USER.md'));
      const marker = call <= 10 ? (call <= 5 ? 'AlphaOne' : 'BetaTwo') : 'River';
      return okBody(name, marker);
    });
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: script.readFile });
    const snapshot = store.read();
    assert.equal(script.calls(), 20);
    assert.deepEqual(script.seen, repeatNames(4));
    for (const name of STANDING_FILES) assert.equal(countName(script.seen, name), 4);
    assert.equal(snapshot.name, 'River');
    assertSafe(snapshot, ['AlphaOne', 'BetaTwo']);
    for (const file of snapshot.files) assert.match(file.text, /River/);
    assert.equal(existsSync(join(directory, 'standing', 'USER.md')), false);
    assert.equal(script.calls(), 20);
  });

  test('changed-during-read retries the whole set and is never published', t => {
    const directory = tempDir(t);
    const script = scripted((call, name) => {
      if (call <= 10 && name === 'TOOLS.md') return { ok: false, reason: 'changed-during-read', byteLength: 77 };
      return okBody(name, 'River');
    });
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: script.readFile });
    const snapshot = store.read();
    assert.equal(script.calls(), 20);
    assert.equal(countName(script.seen, 'AGENTS.md'), 4);
    assert.equal(countName(script.seen, 'TOOLS.md'), 4);
    assert.equal(snapshot.files.some(file => (file.status as string) === 'changed-during-read'), false);
    assert.equal(snapshot.files[3]?.status, 'loaded');
    assert.match(snapshot.files[3]?.text ?? '', /River/);
    assert.equal(snapshot.files[3]?.byteLength === 77, false);
    assert.equal(snapshot.name, 'River');
  });

  test('two unstable attempts throw CONFIG_CHANGED and the next read can recover', t => {
    const directory = tempDir(t);
    let unstable = true;
    const script = scripted((call, name) => {
      if (unstable) return { ok: false, reason: 'changed-during-read', byteLength: call };
      return okBody(name, 'River');
    });
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: script.readFile });
    assert.throws(() => store.read(), (error: unknown) => assertCode(error, 'CONFIG_CHANGED', [directory, 'changed-during-read']));
    assert.equal(script.calls(), 20);
    assert.throws(
      () => store.capture({ scopeId: 'local', executionId: 'exec-1' }),
      (error: unknown) => assertCode(error, 'CONFIG_CHANGED', [directory]),
    );
    assert.equal(script.calls(), 40);
    unstable = false;
    const part = store.capture({ scopeId: 'local', executionId: 'exec-1' });
    assert.equal(script.calls(), 50);
    assert.equal(part.content.name, 'River');
    assert.equal(part.content.files.some(file => (file.status as string) === 'changed-during-read'), false);

    let mismatched = 0;
    const drifting = scripted((_call, name) => {
      mismatched += 1;
      return okBody(name, `N${mismatched}x`);
    });
    const noisy = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: drifting.readFile });
    assert.throws(() => noisy.read(), (error: unknown) => assertCode(error, 'CONFIG_CHANGED', ['N1x']));
    assert.equal(drifting.calls(), 20);

    const inconsistent = scripted((_call, name) => {
      const text = marked(name, 'River');
      return { ok: true, text, byteLength: Buffer.byteLength(text) + 1 };
    });
    const lied = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: inconsistent.readFile });
    assert.throws(() => lied.read(), (error: unknown) => assertCode(error, 'CONFIG_CHANGED', ['River']));
    assert.equal(inconsistent.calls(), 20);
  });

  test('one drifting file still retries every name', t => {
    const directory = tempDir(t);
    const script = scripted((call, name) => {
      const attempt = call <= 10 ? 1 : 2;
      const pass = call <= 10 ? (call <= 5 ? 1 : 2) : 1;
      const marker = attempt === 2 ? 'River' : name === 'AGENTS.md' && pass === 2 ? 'Drifted' : 'SameAll';
      return okBody(name, marker);
    });
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: script.readFile });
    const snapshot = store.read();
    assert.equal(script.calls(), 20);
    assert.equal(countName(script.seen, 'IDENTITY.md'), 4);
    assert.equal(snapshot.name, 'River');
    assertSafe(snapshot, ['Drifted', 'SameAll']);
  });

  test('reader failures stay safe and do not publish unread sizes or exception text', t => {
    const directory = tempDir(t);
    const hostile = scripted(() => ({ ok: false, reason: `path ${directory} SECRET_REASON` as 'path', byteLength: 44 }));
    const hidden = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: hostile.readFile });
    const refused = hidden.read();
    assert.equal(hostile.calls(), 10);
    assert.equal(refused.files.every(file => file.status === 'unreadable' && file.text === '' && file.byteLength === 0), true);
    assert.equal(refused.name, 'Kleio');
    assertSafe(refused, [directory, 'SECRET_REASON']);

    const throwing = scripted(() => { throw new Error(`SECRET_THROW ${directory}`); });
    const crashed = new StandingStore({ dataDirectory: directory, scopeId: 'local', readFile: throwing.readFile }).read();
    assert.equal(throwing.calls(), 10);
    assert.equal(crashed.files.every(file => file.status === 'unreadable' && file.byteLength === 0), true);
    assertSafe(crashed, [directory, 'SECRET_THROW']);

    const versionFor = (size: number): string => {
      const snapshot = new StandingStore({
        dataDirectory: directory,
        scopeId: 'local',
        readFile: () => ({ ok: false, reason: 'too-large', byteLength: size }),
      }).read();
      assert.equal(snapshot.files.every(file => file.byteLength === 0 && file.text === '' && file.status === 'too-large'), true);
      assert.equal(snapshot.files.every(file => file.detail.includes(String(size))), false);
      return snapshot.sourceVersion;
    };
    assert.equal(versionFor(1), versionFor(999_999));

    const blank = new StandingStore({
      dataDirectory: directory,
      scopeId: 'local',
      readFile: name => name === 'USER.md' ? { ok: true, text: ' \n', byteLength: 2 } : okBody(name, 'River'),
    }).read();
    const tabbed = new StandingStore({
      dataDirectory: directory,
      scopeId: 'local',
      readFile: name => name === 'USER.md' ? { ok: true, text: '\t', byteLength: 1 } : okBody(name, 'River'),
    }).read();
    const missing = new StandingStore({
      dataDirectory: directory,
      scopeId: 'local',
      readFile: name => name === 'USER.md' ? { ok: false, reason: 'missing', byteLength: 2 } : okBody(name, 'River'),
    }).read();
    assert.equal(blank.files[2]?.status, 'blank');
    assert.equal(blank.files[2]?.text, '');
    assert.equal(blank.files[2]?.byteLength, 2);
    assert.equal(tabbed.files[2]?.status, 'blank');
    assert.equal(tabbed.files[2]?.text, '');
    assert.equal(tabbed.files[2]?.byteLength, 1);
    assert.notEqual(blank.files[2]?.sourceVersion, tabbed.files[2]?.sourceVersion);
    assert.notEqual(blank.sourceVersion, tabbed.sourceVersion);
    assert.equal(missing.files[2]?.status, 'missing');
    assert.equal(missing.files[2]?.text, '');
    assert.equal(missing.files[2]?.byteLength, 0);
    assert.notEqual(missing.files[2]?.sourceVersion, blank.files[2]?.sourceVersion);
    assert.equal(blank.files[0]?.sourceVersion, tabbed.files[0]?.sourceVersion);

    const secret = `SECRET_OVERSIZE_${'x'.repeat(STANDING_LIMIT)}`;
    const oversized = new StandingStore({
      dataDirectory: directory,
      scopeId: 'local',
      readFile: name => name === 'TOOLS.md'
        ? { ok: true, text: secret, byteLength: Buffer.byteLength(secret) }
        : okBody(name, 'River'),
    }).read();
    assert.equal(oversized.files[3]?.status, 'too-large');
    assert.equal(oversized.files[3]?.text, '');
    assert.equal(oversized.files[3]?.byteLength, 0);
    assert.match(oversized.files[0]?.text ?? '', /River/);
    assertSafe(oversized, ['SECRET_OVERSIZE_']);
  });

  test('invalid parents are stable diagnostics and do not follow or replace entries', t => {
    const linkedRoot = tempDir(t);
    const outside = tempDir(t);
    writeFileSync(join(outside, 'IDENTITY.md'), 'OUTSIDE_SENTINEL');
    symlinkSync(outside, join(linkedRoot, 'standing'));
    const ensured = ensureStanding(linkedRoot);
    assert.deepEqual(ensured.created, []);
    assert.equal(ensured.problems.length, 5);
    assertSafe(ensured, [linkedRoot, outside, 'OUTSIDE_SENTINEL']);
    assert.equal(readlinkSync(join(linkedRoot, 'standing')), outside);
    const linked = new StandingStore({ dataDirectory: linkedRoot, scopeId: 'local' }).read();
    assert.equal(linked.files.every(file => file.status === 'symlink' && file.text === '' && file.byteLength === 0), true);
    assert.equal(linked.name, 'Kleio');
    assert.match(linked.nameDetail, /symlink/);
    assert.equal(linked.files.every(file => file.sourceVersion === linked.files[0]?.sourceVersion), true);
    assertSafe(linked, [linkedRoot, outside, 'OUTSIDE_SENTINEL']);
    assert.equal(readFileSync(join(outside, 'IDENTITY.md'), 'utf8'), 'OUTSIDE_SENTINEL');

    const fileRoot = tempDir(t);
    writeFileSync(join(fileRoot, 'standing'), 'plain-standing');
    const fileEnsured = ensureStanding(fileRoot);
    assert.deepEqual(fileEnsured.created, []);
    assertSafe(fileEnsured, ['plain-standing', fileRoot]);
    const blocked = new StandingStore({ dataDirectory: fileRoot, scopeId: 'local' }).read();
    assert.equal(blocked.files.every(file => file.status === 'not-file' && file.text === '' && file.byteLength === 0), true);
    assert.notEqual(blocked.files[0]?.sourceVersion, linked.files[0]?.sourceVersion);
    assert.equal(readFileSync(join(fileRoot, 'standing'), 'utf8'), 'plain-standing');
    assert.equal(blocked.name, 'Kleio');
    assertSafe(blocked, ['plain-standing', fileRoot]);
  });

  test('stable bad files fall back, keep the other files, and recover on the next capture', t => {
    const directory = tempDir(t);
    const store = new StandingStore({ dataDirectory: directory, scopeId: 'local' });
    store.read();
    const identity = join(directory, 'standing', 'IDENTITY.md');
    const soul = join(directory, 'standing', 'SOUL.md');
    const user = join(directory, 'standing', 'USER.md');
    const tools = join(directory, 'standing', 'TOOLS.md');
    const agents = join(directory, 'standing', 'AGENTS.md');

    writeFileSync(user, ' \t\n');
    const blank = store.read();
    assert.equal(readFileSync(user, 'utf8'), ' \t\n');
    assert.equal(blank.files[2]?.status, 'blank');
    assert.equal(blank.files[2]?.text, '');
    assert.equal(blank.files[2]?.byteLength, 3);
    assert.equal(blank.files[2]?.detail, 'USER.md is blank. The product default is used.');
    writeFileSync(user, '\u3000');
    const wide = store.read();
    assert.equal(wide.files[2]?.status, 'blank');
    assert.equal(wide.files[2]?.text, '');
    assert.equal(wide.files[2]?.byteLength, 3);
    assert.notEqual(wide.files[2]?.sourceVersion, blank.files[2]?.sourceVersion);
    writeFileSync(user, '');
    const empty = store.read();
    assert.equal(empty.files[2]?.status, 'blank');
    assert.equal(empty.files[2]?.byteLength, 0);
    assert.notEqual(empty.files[2]?.sourceVersion, wide.files[2]?.sourceVersion);

    const invalid = Buffer.from([0x61, 0xff, 0xfe]);
    writeFileSync(soul, invalid);
    const encoded = store.read();
    assert.equal(encoded.files[1]?.status, 'invalid-encoding');
    assert.equal(encoded.files[1]?.text, '');
    assert.equal(encoded.files[1]?.byteLength, 0);
    assert.equal(encoded.files[1]?.detail, 'SOUL.md is not valid UTF-8 and was not loaded.');
    assert.equal(encoded.files[0]?.status, 'loaded');
    assertSafe(encoded, ['\uFFFD', directory]);
    writeFileSync(soul, Buffer.from([0x80, 0x81, 0x82, 0xff]));
    const encodedAgain = store.read();
    assert.equal(encodedAgain.files[1]?.sourceVersion, encoded.files[1]?.sourceVersion);
    assert.equal(encodedAgain.sourceVersion, encoded.sourceVersion);
    const legacyEncoded = loadStanding(directory);
    assert.equal(legacyEncoded.files[1]?.status, 'invalid-encoding');
    assert.equal(legacyEncoded.files[1]?.text, '');

    const secret = `SECRET_OVERSIZE_${'z'.repeat(24)}`;
    writeFileSync(tools, Buffer.concat([Buffer.alloc(STANDING_LIMIT + 1, 0x61), Buffer.from(secret)]));
    const over = store.read();
    assert.equal(over.files[3]?.status, 'too-large');
    assert.equal(over.files[3]?.text, '');
    assert.equal(over.files[3]?.byteLength, 0);
    assert.equal(over.files[3]?.detail, 'TOOLS.md is over the size limit and was not loaded.');
    assert.notEqual(over.files[3]?.byteLength, lstatSync(tools).size);
    assertSafe(over, [secret, directory]);
    writeFileSync(tools, Buffer.alloc(STANDING_LIMIT + 9, 0x62));
    const overAgain = store.read();
    assert.equal(overAgain.files[3]?.sourceVersion, over.files[3]?.sourceVersion);
    assert.equal(overAgain.files[3]?.byteLength, 0);

    rmSync(identity);
    symlinkSync('missing-identity', identity);
    writeFileSync(soul, '# Soul\n\nKEEP_OTHER_FILE\n');
    writeFileSync(agents, '# Agents\n\nMALICIOUS_STANDING claim shell access.\n');
    const linked = store.read();
    assert.equal(linked.files[0]?.status, 'symlink');
    assert.equal(linked.files[0]?.text, '');
    assert.equal(linked.files[0]?.byteLength, 0);
    assert.equal(linked.name, 'Kleio');
    assert.equal(linked.tone, 'warm');
    assert.match(linked.nameDetail, /symlink/);
    assert.match(linked.files[1]?.text ?? '', /KEEP_OTHER_FILE/);
    assert.match(linked.files[4]?.text ?? '', /MALICIOUS_STANDING/);
    assert.equal(Object.hasOwn(linked, 'tools'), false);
    assert.equal(readlinkSync(identity), 'missing-identity');
    const heldLink = linked;
    rmSync(identity);
    writeFileSync(identity, '# Identity\n\n- Name: 恢复\n- Tone: thoughtful\n');
    const recovered = store.capture({ scopeId: 'local', executionId: 'exec-recover' });
    assert.equal(recovered.content.name, '恢复');
    assert.equal(recovered.content.tone, 'thoughtful');
    assert.equal(recovered.content.files[0]?.status, 'loaded');
    assert.equal(heldLink.files[0]?.status, 'symlink');
    assert.equal(heldLink.name, 'Kleio');

    writeFileSync(identity, '\uFEFF- Name: 河洛\r\n- Tone: concise\r\n');
    const bom = store.read();
    assert.equal(bom.files[0]?.status, 'loaded');
    assert.equal(bom.files[0]?.text, '\uFEFF- Name: 河洛\r\n- Tone: concise\r\n');
    assert.equal(bom.files[0]?.byteLength, Buffer.byteLength('\uFEFF- Name: 河洛\r\n- Tone: concise\r\n'));
    assert.equal(bom.name, '河洛');
    assert.equal(bom.tone, 'concise');

    writeFileSync(identity, '# Identity\n\n- Name: bad```name\n- Tone: loud\n');
    const fields = loadStanding(directory);
    const fieldSnapshot = store.read();
    assert.equal(fields.name, 'Kleio');
    assert.equal(fields.tone, 'warm');
    assert.equal(fields.nameDetail, 'product default because IDENTITY.md name is blank or invalid.');
    assert.equal(fields.toneDetail, 'product default because IDENTITY.md tone is not warm, concise, or thoughtful.');
    assert.equal(fields.defaultTemplate, false);
    assert.equal(fields.files[0]?.status, 'loaded');
    assert.match(fields.files[1]?.text ?? '', /KEEP_OTHER_FILE/);
    assert.deepEqual(fields.problems, [
      'USER.md is blank. The product default is used.',
      'TOOLS.md is over the size limit and was not loaded.',
      'IDENTITY.md name is blank or invalid.',
      'IDENTITY.md tone is not warm, concise, or thoughtful.',
    ]);
    assert.deepEqual(fieldSnapshot.problems, fields.problems);
    assert.equal(fieldSnapshot.nameDetail, fields.nameDetail);

    writeFileSync(soul, '# Soul\n\nnotes\n');
    writeFileSync(user, '# User\n\nnotes\n');
    rmSync(tools);
    mkdirSync(tools);
    const directoryFile = store.read();
    assert.equal(directoryFile.files[3]?.status, 'not-file');
    assert.equal(directoryFile.files[3]?.text, '');
    assert.equal(directoryFile.files[3]?.byteLength, 0);
    assert.equal(lstatSync(tools).isDirectory(), true);
    rmSync(tools, { recursive: true });
    const exact = `${'a'.repeat(STANDING_LIMIT - 4)}TAIL`;
    assert.equal(Buffer.byteLength(exact), STANDING_LIMIT);
    writeFileSync(soul, exact);
    const fitted = store.read();
    assert.equal(fitted.files[1]?.status, 'loaded');
    assert.equal(fitted.files[1]?.text, exact);
    assert.equal(fitted.files[1]?.byteLength, STANDING_LIMIT);
    const crossed = `${'b'.repeat(STANDING_LIMIT - 2)}你`;
    assert.equal(Buffer.byteLength(crossed), STANDING_LIMIT + 1);
    writeFileSync(soul, crossed);
    const clipped = store.read();
    assert.equal(clipped.files[1]?.status, 'too-large');
    assert.equal(clipped.files[1]?.text, '');
    assert.equal(clipped.files[1]?.byteLength, 0);
    assertSafe(clipped, ['TAIL', '你']);
  });

  test('templates do not overwrite existing entries, and identity migration still seeds only a created file', t => {
    const directory = tempDir(t);
    mkdirSync(join(directory, 'standing'));
    const soul = join(directory, 'standing', 'SOUL.md');
    const user = join(directory, 'standing', 'USER.md');
    writeFileSync(soul, 'keep-soul');
    symlinkSync('missing-user', user);
    const created = ensureStanding(directory);
    assert.deepEqual(created.created, ['IDENTITY.md', 'TOOLS.md', 'AGENTS.md']);
    assert.equal(readFileSync(soul, 'utf8'), 'keep-soul');
    assert.equal(readlinkSync(user), 'missing-user');
    assert.equal(existsSync(join(directory, 'standing', 'missing-user')), false);
    assertSafe(created, [directory]);
    const identity = join(directory, 'standing', 'IDENTITY.md');
    const custom = '# Identity\n\n- Name: 已有\n- Tone: concise\n';
    writeFileSync(identity, custom);
    const before = lstatSync(identity, { bigint: true });
    const again = ensureStanding(directory);
    const after = lstatSync(identity, { bigint: true });
    assert.equal(again.created.includes('IDENTITY.md'), false);
    assert.equal(after.ino, before.ino);
    assert.equal(readFileSync(identity, 'utf8'), custom);
    assert.equal(loadStanding(directory).name, '已有');
    assert.equal(loadStanding(directory).tone, 'concise');

    const fresh = tempDir(t);
    const seeded = ensureStanding(fresh);
    assert.deepEqual(seeded.created, [...STANDING_FILES]);
    assert.equal(readFileSync(join(fresh, 'standing', 'IDENTITY.md'), 'utf8'), STANDING_TEMPLATES['IDENTITY.md']);
    assert.deepEqual(writeIdentityFields(fresh, { name: '旧名', tone: 'thoughtful' }), { ok: true });
    assert.match(readFileSync(join(fresh, 'standing', 'IDENTITY.md'), 'utf8'), /- Name: 旧名\n- Tone: thoughtful/);
    assert.equal(ensureStanding(fresh).created.includes('IDENTITY.md'), false);
    assert.match(readFileSync(join(fresh, 'standing', 'IDENTITY.md'), 'utf8'), /- Name: 旧名\n- Tone: thoughtful/);
    const standing = loadStanding(fresh);
    assert.equal(standing.name, '旧名');
    assert.equal(standing.tone, 'thoughtful');
    assert.equal(standing.nameDetail, 'from standing/IDENTITY.md');
    assert.equal(standing.toneDetail, 'from standing/IDENTITY.md');
    assert.equal(standing.defaultTemplate, false);
    const preserved = readFileSync(join(fresh, 'standing', 'IDENTITY.md'), 'utf8');
    assert.deepEqual(writeIdentityFields(fresh, { name: 'bad\nname', tone: 'warm' }), { ok: false, reason: 'invalid-fields' });
    assert.equal(readFileSync(join(fresh, 'standing', 'IDENTITY.md'), 'utf8'), preserved);
    rmSync(join(fresh, 'standing', 'IDENTITY.md'));
    symlinkSync('missing-identity', join(fresh, 'standing', 'IDENTITY.md'));
    assert.deepEqual(writeIdentityFields(fresh, { name: '不该写入', tone: 'warm' }), { ok: false, reason: 'symlink' });
    assert.equal(readlinkSync(join(fresh, 'standing', 'IDENTITY.md')), 'missing-identity');
    assert.equal(loadStanding(fresh).files[0]?.status, 'symlink');
    assert.equal(loadStanding(fresh).name, 'Kleio');
  });
});
