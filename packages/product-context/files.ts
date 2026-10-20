import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import type { StandingReadFailure } from '../context-contracts/context.ts';

/** Failures are product reasons. They never include file contents or credential-bearing paths. */
export type IoReason = 'missing' | 'symlink' | 'not-file' | 'too-large' | 'escape' | 'path' | 'unreadable' | 'invalid-fields';

export type { StandingReadFailure };

export type BoundedRead = { ok: true; text: string } | { ok: false; reason: IoReason };
export type BoundedWrite = { ok: true } | { ok: false; reason: IoReason };

const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;

export function openFollowsSymlinks(): boolean {
  return noFollow === 0;
}

/** Future multi-user callers pass a trusted scope root. L1 has one local directory. */
export function scopeRoot(dataDirectory: string): string {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  return realpathSync(dataDirectory);
}

export function staysInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

function segmentOk(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(segment);
}

type Entry = 'missing' | 'symlink' | 'file' | 'directory' | 'other' | 'unreadable';

/** lstat does not follow links, so a dangling symlink is visible instead of looking missing. */
function entry(path: string): Entry {
  try {
    const listed = lstatSync(path);
    if (listed.isSymbolicLink()) return 'symlink';
    if (listed.isDirectory()) return 'directory';
    if (listed.isFile()) return 'file';
    return 'other';
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/** Read a fixed relative path. Symlinks are refused and never followed. */
export function readBounded(root: string, segments: readonly string[], limit: number): BoundedRead {
  if (!segments.every(segmentOk)) return { ok: false, reason: 'path' };
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const next = join(current, segments[index]!);
    const found = entry(next);
    if (found === 'missing') return { ok: false, reason: 'missing' };
    if (found === 'symlink' || found === 'unreadable') return { ok: false, reason: found };
    const last = index === segments.length - 1;
    if (last ? found !== 'file' : found !== 'directory') return { ok: false, reason: 'not-file' };
    current = next;
  }
  let fd: number;
  try { fd = openSync(current, constants.O_RDONLY | noFollow); }
  catch { return { ok: false, reason: 'symlink' }; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: 'not-file' };
    if (stat.size > limit) return { ok: false, reason: 'too-large' };
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = readSync(fd, buf, offset, stat.size - offset, offset);
      if (n <= 0) return { ok: false, reason: 'unreadable' };
      offset += n;
    }
    let real: string;
    try { real = realpathSync(current); } catch { return { ok: false, reason: 'escape' }; }
    if (!staysInside(root, real)) return { ok: false, reason: 'escape' };
    return { ok: true, text: buf.toString('utf8') };
  } finally { closeSync(fd); }
}

/** Write a regular file inside root. An existing symlink is left in place. */
export function writeBounded(root: string, segments: readonly string[], text: string, limit: number): BoundedWrite {
  if (!segments.every(segmentOk) || segments.length === 0) return { ok: false, reason: 'path' };
  if (Buffer.byteLength(text) > limit) return { ok: false, reason: 'too-large' };
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = join(current, segment);
    const found = entry(next);
    if (found === 'symlink' || found === 'unreadable') return { ok: false, reason: found };
    if (found === 'file' || found === 'other') return { ok: false, reason: 'not-file' };
    if (found === 'missing') {
      try { mkdirSync(next, { mode: 0o700 }); }
      catch (error) {
        const again = entry(next);
        if (again === 'symlink') return { ok: false, reason: 'symlink' };
        if (again === 'file' || again === 'other') return { ok: false, reason: 'not-file' };
        if (again !== 'directory') return { ok: false, reason: codeOf(error) === 'EEXIST' ? 'symlink' : 'unreadable' };
      }
    }
    let real: string;
    try { real = realpathSync(next); } catch { return { ok: false, reason: 'escape' }; }
    if (!staysInside(root, real)) return { ok: false, reason: 'escape' };
    current = real;
  }
  const name = segments[segments.length - 1]!;
  const target = join(current, name);
  const targetEntry = entry(target);
  if (targetEntry === 'symlink' || targetEntry === 'unreadable') return { ok: false, reason: targetEntry };
  if (targetEntry !== 'missing' && targetEntry !== 'file') return { ok: false, reason: 'not-file' };
  const tmp = join(current, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    const buf = Buffer.from(text);
    let offset = 0;
    while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally { if (fd !== undefined) closeSync(fd); }
  try { renameSync(tmp, target); }
  catch {
    try { unlinkSync(tmp); } catch { /* The failed temp file is disposable. */ }
    return { ok: false, reason: 'unreadable' };
  }
  try {
    if (lstatSync(target).isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!staysInside(root, realpathSync(target))) return { ok: false, reason: 'escape' };
  } catch { return { ok: false, reason: 'escape' }; }
  return { ok: true };
}

export type StrictBoundedRead =
  | { ok: true; text: string; byteLength: number }
  | { ok: false; reason: StandingReadFailure; byteLength: number };

/** `exists` means a directory entry was already there and was left untouched. */
export type CreateIfAbsentResult =
  | { ok: true; created: true; exists: false }
  | { ok: true; created: false; exists: true }
  | { ok: false; reason: IoReason };

type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };

function identityOf(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function strictFailure(reason: StandingReadFailure, byteLength = 0): StrictBoundedRead {
  return { ok: false, reason, byteLength };
}

function exceedsCap(size: bigint, limit: number): boolean {
  if (!Number.isSafeInteger(limit) || limit < 0) return true;
  return size > BigInt(limit);
}

function numberSize(size: bigint): number {
  return size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size);
}

/** Same relative-path walk as readBounded. Symlinks are refused before open. */
function locateFile(root: string, segments: readonly string[]): { ok: true; path: string } | { ok: false; reason: IoReason } {
  if (!segments.every(segmentOk)) return { ok: false, reason: 'path' };
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const next = join(current, segments[index]!);
    const found = entry(next);
    if (found === 'missing') return { ok: false, reason: 'missing' };
    if (found === 'symlink' || found === 'unreadable') return { ok: false, reason: found };
    const last = index === segments.length - 1;
    if (last ? found !== 'file' : found !== 'directory') return { ok: false, reason: 'not-file' };
    current = next;
  }
  return { ok: true, path: current };
}

function restat(fd: number): BigIntStats | null {
  try { return fstatSync(fd, { bigint: true }); }
  catch { return null; }
}

function descriptorChanged(fd: number, before: FileIdentity): boolean {
  const again = restat(fd);
  return again === null ? false : !sameIdentity(before, identityOf(again));
}

/**
 * Confirm the path still names the same descriptor, then apply the root guard.
 * A mismatch is a change during the read. This is a local trusted-directory
 * check, not an OS-level defense against an equal-privilege ancestor swap.
 */
function guardFinalPath(root: string, path: string, desc: BigIntStats): { ok: true } | StrictBoundedRead {
  let listed: BigIntStats;
  try { listed = lstatSync(path, { bigint: true }); }
  catch (error) {
    return strictFailure(codeOf(error) === 'ENOENT' ? 'changed-during-read' : 'unreadable');
  }
  if (listed.isSymbolicLink() || !listed.isFile() || !sameIdentity(identityOf(desc), identityOf(listed))) {
    return strictFailure('changed-during-read');
  }
  let real: string;
  try { real = realpathSync(path); }
  catch { return strictFailure('escape'); }
  if (!staysInside(root, real)) return strictFailure('escape');
  try {
    const canonical = lstatSync(real, { bigint: true });
    if (canonical.dev !== desc.dev || canonical.ino !== desc.ino) return strictFailure('changed-during-read');
  } catch { return strictFailure('escape'); }
  return { ok: true };
}

function decodeStrictUtf8(buf: Buffer): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) };
  } catch { return { ok: false }; }
}

/**
 * Standing read. OpenClaw's readWorkspaceBootstrapFile only wraps a bounded
 * descriptor read; the vendored fs-safe package is not in this checkout and was
 * not audited. Kleio keeps its own relative-path adapter, refuses an over-cap
 * body without reading or hashing it, and returns changed-during-read when the
 * pinned descriptor or its path identity moves. Invalid UTF-8 is invalid-encoding.
 * The initial BOM is kept. Legacy readBounded stays lossy and does not recheck.
 */
function readBoundedDescriptor(fd: number, root: string, path: string, limit: number): StrictBoundedRead {
  let beforeStat: BigIntStats;
  try { beforeStat = fstatSync(fd, { bigint: true }); }
  catch { return strictFailure('unreadable'); }
  if (!beforeStat.isFile()) return strictFailure('not-file');
  const before = identityOf(beforeStat);
  if (exceedsCap(beforeStat.size, limit)) {
    const again = restat(fd);
    if (!again) return strictFailure('unreadable');
    if (!sameIdentity(before, identityOf(again))) return strictFailure('changed-during-read');
    const guarded = guardFinalPath(root, path, again);
    if (!guarded.ok) return guarded;
    return strictFailure('too-large', numberSize(again.size));
  }
  const size = numberSize(beforeStat.size);
  let buf: Buffer;
  try { buf = Buffer.alloc(size); }
  catch { return strictFailure('unreadable'); }
  let offset = 0;
  while (offset < size) {
    let n: number;
    try { n = readSync(fd, buf, offset, size - offset, offset); }
    catch { return strictFailure(descriptorChanged(fd, before) ? 'changed-during-read' : 'unreadable'); }
    if (n <= 0) return strictFailure(descriptorChanged(fd, before) ? 'changed-during-read' : 'unreadable');
    offset += n;
  }
  let afterStat: BigIntStats;
  try { afterStat = fstatSync(fd, { bigint: true }); }
  catch { return strictFailure('unreadable'); }
  if (!sameIdentity(before, identityOf(afterStat))) return strictFailure('changed-during-read');
  const guarded = guardFinalPath(root, path, afterStat);
  if (!guarded.ok) return guarded;
  const decoded = decodeStrictUtf8(buf);
  if (!decoded.ok) return strictFailure('invalid-encoding', size);
  return { ok: true, text: decoded.text, byteLength: size };
}

export function readBoundedStrict(root: string, segments: readonly string[], limit: number): StrictBoundedRead {
  const located = locateFile(root, segments);
  if (!located.ok) return strictFailure(located.reason);
  let fd: number;
  try { fd = openSync(located.path, constants.O_RDONLY | noFollow); }
  catch (error) {
    const code = codeOf(error);
    // Locate already refused a symlink. ENOENT/ELOOP here means the entry changed before open.
    if (code === 'ENOENT' || code === 'ELOOP') return strictFailure('changed-during-read');
    return strictFailure('unreadable');
  }
  let result: StrictBoundedRead;
  try { result = readBoundedDescriptor(fd, root, located.path, limit); }
  catch { result = strictFailure('unreadable'); }
  try { closeSync(fd); }
  catch { return strictFailure('unreadable'); }
  return result;
}

function resolveCreateParent(root: string, segments: readonly string[]): { ok: true; directory: string; name: string } | { ok: false; reason: IoReason } {
  if (!segments.every(segmentOk) || segments.length === 0) return { ok: false, reason: 'path' };
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = join(current, segment);
    const found = entry(next);
    if (found === 'symlink' || found === 'unreadable') return { ok: false, reason: found };
    if (found === 'file' || found === 'other') return { ok: false, reason: 'not-file' };
    if (found === 'missing') {
      try { mkdirSync(next, { mode: 0o700 }); }
      catch (error) {
        const again = entry(next);
        if (again === 'symlink') return { ok: false, reason: 'symlink' };
        if (again === 'file' || again === 'other') return { ok: false, reason: 'not-file' };
        if (again !== 'directory') return { ok: false, reason: codeOf(error) === 'EEXIST' ? 'symlink' : 'unreadable' };
      }
    }
    let real: string;
    try { real = realpathSync(next); } catch { return { ok: false, reason: 'escape' }; }
    if (!staysInside(root, real)) return { ok: false, reason: 'escape' };
    current = real;
  }
  return { ok: true, directory: current, name: segments[segments.length - 1]! };
}

type TempWrite = { ok: true; owned: true } | { ok: false; reason: 'unreadable'; owned: boolean };

/** `owned` is true only after this call's exclusive create returns a descriptor. */
function writeNewTemp(tmp: string, text: string): TempWrite {
  let fd: number | undefined;
  let owned = false;
  let failed = false;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    owned = true;
    const buf = Buffer.from(text);
    let offset = 0;
    while (offset < buf.length) {
      const n = writeSync(fd, buf, offset, buf.length - offset);
      if (n <= 0) { failed = true; break; }
      offset += n;
    }
    if (!failed) {
      const written = fstatSync(fd, { bigint: true });
      if (!written.isFile() || written.size !== BigInt(buf.length)) failed = true;
    }
  } catch { failed = true; }
  if (fd !== undefined) {
    try { closeSync(fd); }
    catch { failed = true; }
  }
  if (failed || !owned) return { ok: false, reason: 'unreadable', owned };
  return { ok: true, owned: true };
}

function removeOwnTemp(tmp: string): void {
  try { unlinkSync(tmp); }
  catch { /* Only a temp this call created is passed here. */ }
}

function samePublishedInode(tmp: string, target: string): boolean | null {
  try {
    const left = lstatSync(tmp, { bigint: true });
    const right = lstatSync(target, { bigint: true });
    if (!left.isFile() || !right.isFile()) return false;
    return left.dev === right.dev && left.ino === right.ino;
  } catch { return null; }
}

/**
 * Create a relative file only when that path has no directory entry.
 * The body is written to a temp file in the same directory, hard-linked onto
 * the target, then the temp name is removed. link failure after a raced create
 * leaves the winner in place. Ordinary identity edits still use writeBounded.
 */
export function createBoundedIfAbsent(root: string, segments: readonly string[], text: string, limit: number): CreateIfAbsentResult {
  if (!segments.every(segmentOk) || segments.length === 0) return { ok: false, reason: 'path' };
  if (Buffer.byteLength(text) > limit) return { ok: false, reason: 'too-large' };
  const parent = resolveCreateParent(root, segments);
  if (!parent.ok) return parent;
  const target = join(parent.directory, parent.name);
  const targetEntry = entry(target);
  if (targetEntry === 'unreadable') return { ok: false, reason: 'unreadable' };
  if (targetEntry !== 'missing') return { ok: true, created: false, exists: true };
  const tmp = join(parent.directory, `.${parent.name}.${randomBytes(6).toString('hex')}.tmp`);
  let owned = false;
  try {
    const wrote = writeNewTemp(tmp, text);
    owned = wrote.owned;
    if (!wrote.ok) return { ok: false, reason: 'unreadable' };
    try { linkSync(tmp, target); }
    catch (error) {
      if (codeOf(error) === 'EEXIST' || entry(target) !== 'missing') {
        return entry(target) === 'unreadable'
          ? { ok: false, reason: 'unreadable' }
          : { ok: true, created: false, exists: true };
      }
      return { ok: false, reason: 'unreadable' };
    }
    const published = samePublishedInode(tmp, target);
    if (published === null) return { ok: false, reason: 'unreadable' };
    return published
      ? { ok: true, created: true, exists: false }
      : { ok: true, created: false, exists: true };
  } catch { return { ok: false, reason: 'unreadable' }; }
  finally { if (owned) removeOwnTemp(tmp); }
}
