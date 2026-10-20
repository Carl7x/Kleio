/** G3.2 mechanism tests. Synthetic bodies only. Mutations happen inside the real read or link syscall. */
import { spawnSync } from 'node:child_process';
import { describe, mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDING_LIMIT } from './standing.ts';
import {
  createBoundedIfAbsent, openFollowsSymlinks, readBounded, readBoundedStrict, scopeRoot, writeBounded,
  type StrictBoundedRead,
} from './files.ts';

const require = createRequire(import.meta.url);
const fsCjs = require('node:fs') as typeof import('node:fs');
const LIMIT = STANDING_LIMIT;

function makeRoot(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-g32-'));
  t.after(() => { rmSync(directory, { recursive: true, force: true }); });
  return scopeRoot(directory);
}

function leakFree(value: unknown, secrets: readonly string[]): void {
  const encoded = JSON.stringify(value);
  for (const secret of secrets) assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('\uFFFD'), false);
}

function withPatched(name: 'readSync' | 'linkSync' | 'writeSync' | 'openSync' | 'closeSync', impl: (...args: unknown[]) => unknown, run: () => void): void {
  const mocked = mock.method(fsCjs, name, impl as never);
  const restore = () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
  syncBuiltinESMExports();
  try { run(); }
  finally { restore(); }
}

function temps(directory: string): string[] {
  return readdirSync(directory).filter(name => name.includes('.tmp'));
}

function makeFifo(path: string): void {
  const created = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  assert.equal(created.status, 0);
}

describe('G3.2 standing file bounds', { concurrency: false }, () => {
  test('strict read keeps exact bytes, a leading BOM, and the legacy success shape', (t) => {
    assert.equal(LIMIT, 16 * 1024);
    assert.equal(openFollowsSymlinks(), false);
    const root = makeRoot(t);
    const exact = `${'a'.repeat(LIMIT - 3)}你`;
    assert.equal(Buffer.byteLength(exact), LIMIT);
    writeFileSync(join(root, 'exact.md'), exact);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('名字\r\n')]);
    writeFileSync(join(root, 'bom.md'), bom);
    writeFileSync(join(root, 'blank.md'), ' \t\n');
    writeFileSync(join(root, 'empty.md'), '');

    const exactRead = readBoundedStrict(root, ['exact.md'], LIMIT);
    assert.deepEqual(exactRead, { ok: true, text: exact, byteLength: LIMIT });
    assert.deepEqual(readBounded(root, ['exact.md'], LIMIT), { ok: true, text: exact });
    const bomRead = readBoundedStrict(root, ['bom.md'], LIMIT);
    assert.deepEqual(bomRead, { ok: true, text: '\uFEFF名字\r\n', byteLength: bom.length });
    assert.equal(Buffer.byteLength('\uFEFF名字\r\n'), bom.length);
    assert.deepEqual(readBounded(root, ['bom.md'], LIMIT), { ok: true, text: '\uFEFF名字\r\n' });
    assert.deepEqual(readBoundedStrict(root, ['blank.md'], LIMIT), { ok: true, text: ' \t\n', byteLength: 3 });
    assert.deepEqual(readBoundedStrict(root, ['empty.md'], LIMIT), { ok: true, text: '', byteLength: 0 });
  });

  test('over the cap returns no body, including when a multibyte character crosses it', (t) => {
    const root = makeRoot(t);
    const over = `${'a'.repeat(LIMIT - 2)}你`;
    assert.equal(Buffer.byteLength(over), LIMIT + 1);
    writeFileSync(join(root, 'over.md'), over);
    writeFileSync(join(root, 'one.md'), Buffer.alloc(LIMIT + 1, 0x61));
    writeFileSync(join(root, 'small.md'), 'small');
    const originalReadSync = fsCjs.readSync;
    let reads = 0;
    withPatched('readSync', (...args: unknown[]) => {
      reads += 1;
      return Reflect.apply(originalReadSync, fsCjs, args) as number;
    }, () => {
      assert.deepEqual(readBoundedStrict(root, ['small.md'], LIMIT), { ok: true, text: 'small', byteLength: 5 });
      assert.equal(reads > 0, true);
      reads = 0;
      const multi = readBoundedStrict(root, ['over.md'], LIMIT);
      const ascii = readBoundedStrict(root, ['one.md'], LIMIT);
      assert.equal(reads, 0);
      assert.deepEqual(multi, { ok: false, reason: 'too-large', byteLength: LIMIT + 1 });
      assert.deepEqual(ascii, { ok: false, reason: 'too-large', byteLength: LIMIT + 1 });
      leakFree(multi, [over, root]);
      assert.deepEqual(readBounded(root, ['over.md'], LIMIT), { ok: false, reason: 'too-large' });
      assert.deepEqual(readBounded(root, ['one.md'], LIMIT), { ok: false, reason: 'too-large' });
    });
  });

  test('invalid UTF-8 is refused strictly and still replaced by the legacy read', (t) => {
    const root = makeRoot(t);
    const invalid = Buffer.from([0x61, 0xff, 0xe4, 0xb8]);
    writeFileSync(join(root, 'bad.md'), invalid);
    writeFileSync(join(root, 'full.md'), Buffer.alloc(LIMIT, 0xff));
    writeFileSync(join(root, 'huge.md'), Buffer.alloc(LIMIT + 1, 0xff));
    const legacy = readBounded(root, ['bad.md'], LIMIT);
    assert.equal(legacy.ok, true);
    if (!legacy.ok) return;
    assert.deepEqual(Object.keys(legacy).sort(), ['ok', 'text']);
    assert.equal(legacy.text, invalid.toString('utf8'));
    assert.equal(legacy.text.includes('\uFFFD'), true);
    assert.deepEqual(readBoundedStrict(root, ['bad.md'], LIMIT), { ok: false, reason: 'invalid-encoding', byteLength: invalid.length });
    assert.deepEqual(readBoundedStrict(root, ['full.md'], LIMIT), { ok: false, reason: 'invalid-encoding', byteLength: LIMIT });
    assert.deepEqual(readBoundedStrict(root, ['huge.md'], LIMIT), { ok: false, reason: 'too-large', byteLength: LIMIT + 1 });
    leakFree(readBoundedStrict(root, ['bad.md'], LIMIT), [root]);
  });

  test('symlink, dangling symlink, and non-file boundaries stay closed', (t) => {
    const root = makeRoot(t);
    const outside = mkdtempSync(join(tmpdir(), 'kleio-g32-out-'));
    t.after(() => { rmSync(outside, { recursive: true, force: true }); });
    writeFileSync(join(root, 'real.md'), 'LINK_TARGET_SENTINEL');
    symlinkSync('real.md', join(root, 'link.md'));
    symlinkSync('missing-target', join(root, 'dangling.md'));
    mkdirSync(join(root, 'folder'));
    makeFifo(join(root, 'pipe'));
    writeFileSync(join(outside, 'IDENTITY.md'), 'OUTSIDE_SENTINEL');
    const outsideBytes = readFileSync(join(outside, 'IDENTITY.md'));
    symlinkSync(outside, join(root, 'standing'));

    for (const name of ['link.md', 'dangling.md']) {
      assert.deepEqual(readBounded(root, [name], LIMIT), { ok: false, reason: 'symlink' });
      assert.deepEqual(readBoundedStrict(root, [name], LIMIT), { ok: false, reason: 'symlink', byteLength: 0 });
    }
    assert.equal(lstatSync(join(root, 'pipe')).isFIFO(), true);
    for (const name of ['folder', 'pipe']) {
      assert.deepEqual(readBounded(root, [name], LIMIT), { ok: false, reason: 'not-file' });
      assert.deepEqual(readBoundedStrict(root, [name], LIMIT), { ok: false, reason: 'not-file', byteLength: 0 });
    }
    assert.deepEqual(readBounded(root, ['standing', 'IDENTITY.md'], LIMIT), { ok: false, reason: 'symlink' });
    const crossed = readBoundedStrict(root, ['standing', 'IDENTITY.md'], LIMIT);
    assert.deepEqual(crossed, { ok: false, reason: 'symlink', byteLength: 0 });
    leakFree(crossed, ['LINK_TARGET_SENTINEL', 'OUTSIDE_SENTINEL', root, outside]);
    assert.deepEqual(readBoundedStrict(root, ['..', 'secret'], LIMIT), { ok: false, reason: 'path', byteLength: 0 });
    assert.deepEqual(readBoundedStrict(root, ['missing.md'], LIMIT), { ok: false, reason: 'missing', byteLength: 0 });
    assert.deepEqual(readFileSync(join(outside, 'IDENTITY.md')), outsideBytes);
    assert.equal(lstatSync(join(root, 'dangling.md')).isSymbolicLink(), true);
  });

  test('create-if-absent publishes once and leaves existing entries untouched', (t) => {
    const root = makeRoot(t);
    const body = '\uFEFF模板\n';
    assert.deepEqual(createBoundedIfAbsent(root, ['standing', 'SOUL.md'], body, LIMIT), { ok: true, created: true, exists: false });
    const createdPath = join(root, 'standing', 'SOUL.md');
    assert.equal(readFileSync(createdPath, 'utf8'), body);
    assert.equal(lstatSync(createdPath).isSymbolicLink(), false);
    assert.equal(lstatSync(createdPath).nlink, 1);
    assert.deepEqual(temps(join(root, 'standing')), []);
    assert.deepEqual(createBoundedIfAbsent(root, ['standing', 'SOUL.md'], 'other-template', LIMIT), { ok: true, created: false, exists: true });
    assert.equal(readFileSync(createdPath, 'utf8'), body);

    assert.deepEqual(writeBounded(root, ['standing', 'IDENTITY.md'], 'first-body', LIMIT), { ok: true });
    assert.deepEqual(writeBounded(root, ['standing', 'IDENTITY.md'], 'second-body', LIMIT), { ok: true });
    const identity = join(root, 'standing', 'IDENTITY.md');
    const before = lstatSync(identity, { bigint: true });
    assert.deepEqual(createBoundedIfAbsent(root, ['standing', 'IDENTITY.md'], 'template-body', LIMIT), { ok: true, created: false, exists: true });
    const after = lstatSync(identity, { bigint: true });
    assert.equal(readFileSync(identity, 'utf8'), 'second-body');
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);

    writeFileSync(join(root, 'standing', 'real.md'), 'KEEP_FILE');
    symlinkSync('real.md', join(root, 'standing', 'USER.md'));
    symlinkSync('missing-target', join(root, 'standing', 'TOOLS.md'));
    mkdirSync(join(root, 'standing', 'AGENTS.md'));
    makeFifo(join(root, 'standing', 'pipe.md'));
    assert.deepEqual(createBoundedIfAbsent(root, ['standing', 'USER.md'], 'template', LIMIT), { ok: true, created: false, exists: true });
    assert.deepEqual(createBoundedIfAbsent(root, ['standing', 'TOOLS.md'], 'template', LIMIT), { ok: true, created: false, exists: true });
    assert.deepEqual(createBoundedIfAbsent(root, ['standing', 'AGENTS.md'], 'template', LIMIT), { ok: true, created: false, exists: true });
    assert.deepEqual(createBoundedIfAbsent(root, ['standing', 'pipe.md'], 'template', LIMIT), { ok: true, created: false, exists: true });
    assert.equal(readlinkSync(join(root, 'standing', 'USER.md')), 'real.md');
    assert.equal(readFileSync(join(root, 'standing', 'real.md'), 'utf8'), 'KEEP_FILE');
    assert.equal(readlinkSync(join(root, 'standing', 'TOOLS.md')), 'missing-target');
    assert.equal(lstatSync(join(root, 'standing', 'AGENTS.md')).isDirectory(), true);
    assert.equal(lstatSync(join(root, 'standing', 'pipe.md')).isFIFO(), true);
    assert.equal(lstatSync(join(root, 'standing', 'pipe.md')).isFile(), false);
    assert.deepEqual(temps(join(root, 'standing')), []);
    const edge = 'b'.repeat(LIMIT);
    assert.deepEqual(createBoundedIfAbsent(root, ['notes', 'edge.md'], edge, LIMIT), { ok: true, created: true, exists: false });
    assert.equal(readFileSync(join(root, 'notes', 'edge.md'), 'utf8'), edge);
    assert.deepEqual(createBoundedIfAbsent(root, ['notes', 'EMPTY.md'], '', LIMIT), { ok: true, created: true, exists: false });
    assert.equal(readFileSync(join(root, 'notes', 'EMPTY.md'), 'utf8'), '');
    writeFileSync(join(root, 'blocked'), 'KEEP_PARENT');
    assert.deepEqual(createBoundedIfAbsent(root, ['blocked', 'IDENTITY.md'], 'template', LIMIT), { ok: false, reason: 'not-file' });
    assert.equal(readFileSync(join(root, 'blocked'), 'utf8'), 'KEEP_PARENT');

    const huge = '你'.repeat(LIMIT);
    assert.equal(Buffer.byteLength(huge) > LIMIT, true);
    assert.equal(existsSync(join(root, 'skipped')), false);
    assert.deepEqual(createBoundedIfAbsent(root, ['skipped', 'BIG.md'], huge, LIMIT), { ok: false, reason: 'too-large' });
    assert.equal(existsSync(join(root, 'skipped')), false);
    assert.deepEqual(createBoundedIfAbsent(root, ['..', 'secret'], 'x', LIMIT), { ok: false, reason: 'path' });
    assert.deepEqual(createBoundedIfAbsent(root, ['a/b'], 'x', LIMIT), { ok: false, reason: 'path' });
  });

  test('a parent symlink is not followed or overwritten', (t) => {
    const root = makeRoot(t);
    const outside = mkdtempSync(join(tmpdir(), 'kleio-g32-out-'));
    t.after(() => { rmSync(outside, { recursive: true, force: true }); });
    writeFileSync(join(outside, 'IDENTITY.md'), 'OUTSIDE_SENTINEL');
    const before = readFileSync(join(outside, 'IDENTITY.md'));
    symlinkSync(outside, join(root, 'standing'));
    const result = createBoundedIfAbsent(root, ['standing', 'IDENTITY.md'], 'TEMPLATE_SENTINEL', LIMIT);
    assert.deepEqual(result, { ok: false, reason: 'symlink' });
    leakFree(result, ['OUTSIDE_SENTINEL', 'TEMPLATE_SENTINEL', root, outside]);
    assert.deepEqual(readFileSync(join(outside, 'IDENTITY.md')), before);
    assert.equal(readlinkSync(join(root, 'standing')), outside);
  });

  test('link races keep the winner and a failed publish removes only the temp file', (t) => {
    const root = makeRoot(t);
    const template = 'TEMPLATE_SENTINEL';
    const raced = 'RACED_SENTINEL';
    const originalLink = fsCjs.linkSync;
    let sawCompleteTemp = false;
    withPatched('linkSync', (...args: unknown[]) => {
      const tmp = String(args[0]);
      const target = String(args[1]);
      assert.equal(fsCjs.readFileSync(tmp, 'utf8'), template);
      sawCompleteTemp = true;
      fsCjs.writeFileSync(target, raced);
      return Reflect.apply(originalLink, fsCjs, args);
    }, () => {
      const result = createBoundedIfAbsent(root, ['standing', 'IDENTITY.md'], template, LIMIT);
      assert.equal(sawCompleteTemp, true);
      assert.deepEqual(result, { ok: true, created: false, exists: true });
      leakFree(result, [template, raced, root]);
    });
    const identity = join(root, 'standing', 'IDENTITY.md');
    assert.equal(readFileSync(identity, 'utf8'), raced);
    assert.equal(lstatSync(identity).nlink, 1);
    assert.deepEqual(temps(join(root, 'standing')), []);

    withPatched('linkSync', (...args: unknown[]) => {
      fsCjs.symlinkSync('kept-target', String(args[1]));
      return Reflect.apply(originalLink, fsCjs, args);
    }, () => {
      const result = createBoundedIfAbsent(root, ['standing', 'SOUL.md'], template, LIMIT);
      assert.deepEqual(result, { ok: true, created: false, exists: true });
      leakFree(result, [template, root]);
    });
    assert.equal(readlinkSync(join(root, 'standing', 'SOUL.md')), 'kept-target');
    assert.deepEqual(temps(join(root, 'standing')), []);

    withPatched('linkSync', (...args: unknown[]) => {
      assert.equal(fsCjs.readFileSync(String(args[0]), 'utf8'), '完整模板\n');
      throw Object.assign(new Error(`PRIVATE_LINK ${root}`), { code: 'EIO' });
    }, () => {
      const result = createBoundedIfAbsent(root, ['standing', 'USER.md'], '完整模板\n', LIMIT);
      assert.deepEqual(result, { ok: false, reason: 'unreadable' });
      leakFree(result, ['PRIVATE_LINK', '完整模板', root]);
    });
    assert.equal(existsSync(join(root, 'standing', 'USER.md')), false);
    assert.deepEqual(temps(join(root, 'standing')), []);

    withPatched('writeSync', () => {
      throw Object.assign(new Error(`PRIVATE_WRITE ${root}`), { code: 'EIO' });
    }, () => {
      const result = createBoundedIfAbsent(root, ['standing', 'TOOLS.md'], template, LIMIT);
      assert.deepEqual(result, { ok: false, reason: 'unreadable' });
      leakFree(result, ['PRIVATE_WRITE', template, root]);
    });
    assert.equal(existsSync(join(root, 'standing', 'TOOLS.md')), false);
    assert.deepEqual(temps(join(root, 'standing')), []);
    assert.equal(readFileSync(identity, 'utf8'), raced);
  });

  test('growth, shrink, and replacement during the read are changed-during-read', (t) => {
    const root = makeRoot(t);
    const originalReadSync = fsCjs.readSync;
    const note = join(root, 'note.md');

    const prefix = 'PREFIX_SENTINEL';
    writeFileSync(note, prefix);
    let grew = false;
    withPatched('readSync', (...args: unknown[]) => {
      if (!grew) {
        grew = true;
        fsCjs.appendFileSync(note, `GROWTH_SENTINEL${'x'.repeat(LIMIT)}`);
      }
      return Reflect.apply(originalReadSync, fsCjs, args) as number;
    }, () => {
      const result = readBoundedStrict(root, ['note.md'], LIMIT);
      assert.equal(grew, true);
      assert.equal(fsCjs.statSync(note).size > Buffer.byteLength(prefix), true);
      assert.deepEqual(result, { ok: false, reason: 'changed-during-read', byteLength: 0 });
      leakFree(result, [prefix, 'GROWTH_SENTINEL', root]);
    });
    const grown = readBoundedStrict(root, ['note.md'], LIMIT);
    assert.deepEqual(grown, { ok: false, reason: 'too-large', byteLength: fsCjs.statSync(note).size });
    leakFree(grown, [prefix, 'GROWTH_SENTINEL', root]);

    writeFileSync(note, prefix);
    let legacyGrew = false;
    withPatched('readSync', (...args: unknown[]) => {
      if (!legacyGrew) {
        legacyGrew = true;
        fsCjs.appendFileSync(note, 'LEGACY_TAIL');
      }
      return Reflect.apply(originalReadSync, fsCjs, args) as number;
    }, () => {
      const legacy = readBounded(root, ['note.md'], LIMIT);
      assert.equal(legacyGrew, true);
      assert.deepEqual(legacy, { ok: true, text: prefix });
      assert.equal(fsCjs.statSync(note).size > Buffer.byteLength(prefix), true);
    });

    const oldBody = 'OLD_SENTINEL_BODY';
    const newBody = 'NEW_SENTINEL_BODY';
    writeFileSync(note, oldBody);
    const beforeRename = lstatSync(note, { bigint: true });
    let replaced = false;
    withPatched('readSync', (...args: unknown[]) => {
      if (!replaced) {
        replaced = true;
        const side = join(root, 'side.md');
        fsCjs.writeFileSync(side, newBody);
        fsCjs.renameSync(side, note);
      }
      return Reflect.apply(originalReadSync, fsCjs, args) as number;
    }, () => {
      const result = readBoundedStrict(root, ['note.md'], LIMIT);
      const afterRename = lstatSync(note, { bigint: true });
      assert.equal(replaced, true);
      assert.notEqual(afterRename.ino, beforeRename.ino);
      assert.equal(readFileSync(note, 'utf8'), newBody);
      assert.deepEqual(result, { ok: false, reason: 'changed-during-read', byteLength: 0 });
      leakFree(result, [oldBody, newBody, root]);
    });

    const sameOld = 'OLD_SENTINEL_1234';
    const sameNew = 'NEW_SENTINEL_5678';
    assert.equal(Buffer.byteLength(sameOld), Buffer.byteLength(sameNew));
    writeFileSync(note, sameOld);
    const beforeWrite = lstatSync(note, { bigint: true });
    let rewrote = false;
    withPatched('readSync', (...args: unknown[]) => {
      if (!rewrote) {
        rewrote = true;
        fsCjs.writeFileSync(note, sameNew);
      }
      return Reflect.apply(originalReadSync, fsCjs, args) as number;
    }, () => {
      const result = readBoundedStrict(root, ['note.md'], LIMIT);
      const afterWrite = lstatSync(note, { bigint: true });
      assert.equal(rewrote, true);
      assert.equal(afterWrite.ino, beforeWrite.ino);
      assert.equal(afterWrite.size, beforeWrite.size);
      assert.notEqual(afterWrite.mtimeNs, beforeWrite.mtimeNs);
      assert.equal(readFileSync(note, 'utf8'), sameNew);
      assert.deepEqual(result, { ok: false, reason: 'changed-during-read', byteLength: 0 });
      leakFree(result, [sameOld, sameNew, root]);
    });

    writeFileSync(note, 'SHRINK_SENTINEL');
    let shrunk = false;
    withPatched('readSync', (...args: unknown[]) => {
      if (!shrunk) {
        shrunk = true;
        fsCjs.truncateSync(note, 0);
      }
      return Reflect.apply(originalReadSync, fsCjs, args) as number;
    }, () => {
      const result = readBoundedStrict(root, ['note.md'], LIMIT);
      assert.equal(shrunk, true);
      assert.equal(fsCjs.statSync(note).size, 0);
      assert.deepEqual(result, { ok: false, reason: 'changed-during-read', byteLength: 0 });
      leakFree(result, ['SHRINK_SENTINEL', root]);
    });

    writeFileSync(note, 'LINK_RACE_SENTINEL');
    let swapped = false;
    withPatched('readSync', (...args: unknown[]) => {
      if (!swapped) {
        swapped = true;
        fsCjs.writeFileSync(join(root, 'other.md'), 'OTHER_SECRET');
        fsCjs.unlinkSync(note);
        fsCjs.symlinkSync('other.md', note);
      }
      return Reflect.apply(originalReadSync, fsCjs, args) as number;
    }, () => {
      const result = readBoundedStrict(root, ['note.md'], LIMIT);
      assert.equal(swapped, true);
      assert.equal(lstatSync(note).isSymbolicLink(), true);
      assert.deepEqual(result, { ok: false, reason: 'changed-during-read', byteLength: 0 });
      leakFree(result, ['LINK_RACE_SENTINEL', 'OTHER_SECRET', root]);
    });
    assert.equal(readlinkSync(note), 'other.md');
    assert.equal(readFileSync(join(root, 'other.md'), 'utf8'), 'OTHER_SECRET');

    fsCjs.unlinkSync(note);
    writeFileSync(note, 'plain');
    withPatched('readSync', () => {
      throw Object.assign(new Error(`PRIVATE_READ ${root} SECRET_BODY`), { code: 'EIO' });
    }, () => {
      const result: StrictBoundedRead = readBoundedStrict(root, ['note.md'], LIMIT);
      assert.deepEqual(result, { ok: false, reason: 'unreadable', byteLength: 0 });
      leakFree(result, ['PRIVATE_READ', 'SECRET_BODY', root]);
    });
    assert.equal(readFileSync(note, 'utf8'), 'plain');
  });

  test('an exclusive temp name collision leaves the other inode untouched', (t) => {
    const root = makeRoot(t);
    const originalOpen = fsCjs.openSync;
    let collision = '';
    let identity: { dev: bigint; ino: bigint; size: bigint } | undefined;
    withPatched('openSync', (...args: unknown[]) => {
      const path = String(args[0]);
      if (collision === '' && path.endsWith('.tmp')) {
        const fd = Reflect.apply(originalOpen, fsCjs, args) as number;
        fsCjs.writeSync(fd, 'OTHER_WRITER_TEMP');
        fsCjs.closeSync(fd);
        const stat = lstatSync(path, { bigint: true });
        identity = { dev: stat.dev, ino: stat.ino, size: stat.size };
        collision = path;
        throw Object.assign(new Error('PRIVATE_OPEN_COLLISION'), { code: 'EEXIST' });
      }
      return Reflect.apply(originalOpen, fsCjs, args) as number;
    }, () => {
      const result = createBoundedIfAbsent(root, ['note.md'], 'TEMPLATE_SENTINEL', LIMIT);
      assert.deepEqual(result, { ok: false, reason: 'unreadable' });
      leakFree(result, ['OTHER_WRITER_TEMP', 'TEMPLATE_SENTINEL', 'PRIVATE_OPEN_COLLISION', root]);
    });
    assert.equal(existsSync(join(root, 'note.md')), false);
    assert.notEqual(collision, '');
    assert.ok(identity);
    const after = lstatSync(collision, { bigint: true });
    assert.equal(after.dev, identity.dev);
    assert.equal(after.ino, identity.ino);
    assert.equal(after.size, identity.size);
    assert.equal(readFileSync(collision, 'utf8'), 'OTHER_WRITER_TEMP');
  });

  test('close failures return unreadable and remove only a temp this call created', (t) => {
    const root = makeRoot(t);
    const originalClose = fsCjs.closeSync;
    writeFileSync(join(root, 'note.md'), 'VISIBLE_BODY');
    withPatched('closeSync', (...args: unknown[]) => {
      Reflect.apply(originalClose, fsCjs, args);
      throw Object.assign(new Error(`PRIVATE_CLOSE_DETAIL ${root}`), { code: 'EIO' });
    }, () => {
      let thrown = false;
      try {
        const result = readBoundedStrict(root, ['note.md'], LIMIT);
        assert.deepEqual(result, { ok: false, reason: 'unreadable', byteLength: 0 });
        leakFree(result, ['PRIVATE_CLOSE_DETAIL', 'VISIBLE_BODY', root]);
      } catch {
        thrown = true;
      }
      assert.equal(thrown, false);
    });
    assert.equal(readFileSync(join(root, 'note.md'), 'utf8'), 'VISIBLE_BODY');

    let closedOwned = false;
    withPatched('closeSync', (...args: unknown[]) => {
      closedOwned = true;
      Reflect.apply(originalClose, fsCjs, args);
      throw Object.assign(new Error(`PRIVATE_CLOSE_DETAIL ${root}`), { code: 'EIO' });
    }, () => {
      let thrown = false;
      try {
        const result = createBoundedIfAbsent(root, ['standing', 'IDENTITY.md'], 'TEMPLATE_SENTINEL', LIMIT);
        assert.equal(closedOwned, true);
        assert.deepEqual(result, { ok: false, reason: 'unreadable' });
        leakFree(result, ['PRIVATE_CLOSE_DETAIL', 'TEMPLATE_SENTINEL', root]);
      } catch {
        thrown = true;
      }
      assert.equal(thrown, false);
    });
    assert.equal(existsSync(join(root, 'standing', 'IDENTITY.md')), false);
    assert.deepEqual(temps(join(root, 'standing')), []);
  });
});
