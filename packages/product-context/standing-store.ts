import { createHash, randomUUID } from 'node:crypto';
import {
  CONTEXT_SCHEMA_VERSION,
  STANDING_STABLE_FAILURES,
  STANDING_TRANSIENT_READ_FAILURES,
  type ContextScope,
  type StandingContextPart,
  type StandingFileStateV1,
  type StandingSnapshotV1,
  type StandingStableFailure,
} from '../context-contracts/context.ts';
import { readBoundedStrict, type StrictBoundedRead } from './files.ts';
import {
  DEFAULT_NAME,
  DEFAULT_TONE,
  ensureStandingFiles,
  ioDetail,
  openDataRoot,
  parseIdentity,
  STANDING_FILES,
  STANDING_LIMIT,
  STANDING_TEMPLATES,
  standingSegments,
  StandingStoreError,
  type StandingName,
  type Tone,
} from './standing-source.ts';

/**
 * Publishes one immutable standing snapshot for a trusted data root.
 *
 * Codex replaces applied instructions only after a refresh validates.
 * OpenClaw compares bootstrap name, content, and missing state at a boundary.
 * This store checks five fixed files the same way: create missing templates,
 * read the set twice, and publish only when name, status, content version,
 * and byte length all agree. It keeps no process cache and does not version by mtime.
 */

const COLLECTION_ATTEMPTS = 2;
const STABLE_FAILURES = new Set<string>(STANDING_STABLE_FAILURES);
const TRANSIENT_FAILURES = new Set<string>(STANDING_TRANSIENT_READ_FAILURES);

/** Trusted reader for one standing file. It cannot choose a path; the store names the file. */
export type StandingFileReader = (name: StandingName) => StrictBoundedRead;

export type StandingStoreOptions = {
  readonly dataDirectory: string;
  readonly scopeId: string;
  /**
   * Trusted test or service reader. Production omits it and uses strict reads
   * of the fixed standing paths at the 16 KiB cap. Not model input.
   */
  readonly readFile?: StandingFileReader;
};

type ObservedFile = {
  readonly name: StandingName;
  readonly status: StandingFileStateV1['status'] | 'changed-during-read';
  readonly text: string;
  readonly detail: string;
  readonly sourceVersion: string;
  readonly byteLength: number;
};

type IdentityProjection = {
  readonly name: string;
  readonly tone: Tone;
  readonly nameDetail: string;
  readonly toneDetail: string;
  readonly defaultTemplate: boolean;
  readonly problems: string[];
};

export class StandingStore {
  readonly #dataDirectory: string;
  readonly #scopeId: string;
  readonly #readFile: StandingFileReader | undefined;

  /** Stores trusted config. Does not create directories or read standing files. */
  constructor(options: StandingStoreOptions) {
    this.#dataDirectory = options.dataDirectory;
    this.#scopeId = options.scopeId;
    this.#readFile = options.readFile;
  }

  /** Current standing for a display API. Same collection as capture. */
  read(): StandingSnapshotV1 {
    return this.#publish(this.#load());
  }

  /**
   * Execution snapshot. The caller's scope is whitelisted into an owned copy
   * before any standing IO. A mismatch uses that copy and returns before IO.
   */
  capture(scope: ContextScope): StandingContextPart {
    const owned = ownScope(scope);
    if (owned === null || owned.scopeId !== this.#scopeId) throw new StandingStoreError('CONTEXT_SCOPE_MISMATCH');
    const content = this.read();
    const part: StandingContextPart = {
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      id: content.snapshotId,
      scope: owned,
      kind: 'standing',
      authority: 'user-config',
      sourceRef: 'standing',
      sourceVersion: content.sourceVersion,
      required: true,
      content,
    };
    return freezeDeep(part);
  }

  #load(): readonly ObservedFile[] {
    const root = openDataRoot(this.#dataDirectory);
    ensureStandingFiles(root);
    const read = this.#reader(root);
    for (let attempt = 0; attempt < COLLECTION_ATTEMPTS; attempt += 1) {
      const first = collect(read);
      const second = collect(read);
      if (publishable(first, second)) return first;
    }
    throw new StandingStoreError('CONFIG_CHANGED');
  }

  #reader(root: string): StandingFileReader {
    const injected = this.#readFile;
    if (typeof injected === 'function') return injected;
    return name => readBoundedStrict(root, standingSegments(name), STANDING_LIMIT);
  }

  #publish(files: readonly ObservedFile[]): StandingSnapshotV1 {
    const published = asSet(files.map(toPublished));
    const identity = projectStandingIdentity(published);
    const snapshot: StandingSnapshotV1 = {
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      scopeId: this.#scopeId,
      snapshotId: randomUUID(),
      sourceVersion: collectionVersion(published),
      files: published,
      name: identity.name,
      tone: identity.tone,
      nameDetail: identity.nameDetail,
      toneDetail: identity.toneDetail,
      defaultTemplate: identity.defaultTemplate,
      problems: identity.problems.slice(),
    };
    return freezeDeep(snapshot);
  }
}

/** String fields only. Invalid or null input yields null and does not touch the caller. */
function ownScope(scope: unknown): ContextScope | null {
  if (typeof scope !== 'object' || scope === null) return null;
  const record = scope as Record<string, unknown>;
  if (typeof record.scopeId !== 'string' || typeof record.executionId !== 'string') return null;
  const copy: { scopeId: string; executionId: string; conversationId?: string; workId?: string } = {
    scopeId: record.scopeId,
    executionId: record.executionId,
  };
  if (typeof record.conversationId === 'string') copy.conversationId = record.conversationId;
  if (typeof record.workId === 'string') copy.workId = record.workId;
  return copy;
}

function collect(read: StandingFileReader): ObservedFile[] {
  return STANDING_FILES.map(name => classify(name, readOne(read, name)));
}

function readOne(read: StandingFileReader, name: StandingName): StrictBoundedRead {
  try {
    const result = read(name);
    if (!result || typeof result !== 'object' || (result.ok !== true && result.ok !== false)) {
      return { ok: false, reason: 'unreadable', byteLength: 0 };
    }
    return result;
  } catch {
    return { ok: false, reason: 'unreadable', byteLength: 0 };
  }
}

function classify(name: StandingName, read: StrictBoundedRead): ObservedFile {
  if (read.ok) return classifyBody(name, read.text, read.byteLength);
  if (typeof read.reason !== 'string') return unavailable(name, 'unreadable');
  if (TRANSIENT_FAILURES.has(read.reason)) return transient(name);
  if (STABLE_FAILURES.has(read.reason)) return unavailable(name, read.reason as StandingStableFailure);
  return unavailable(name, 'unreadable');
}

function classifyBody(name: StandingName, text: unknown, reported: unknown): ObservedFile {
  if (typeof reported === 'number' && Number.isSafeInteger(reported) && reported > STANDING_LIMIT) {
    return unavailable(name, 'too-large');
  }
  if (typeof text !== 'string' || typeof reported !== 'number' || !Number.isSafeInteger(reported) || reported < 0) {
    return unavailable(name, 'unreadable');
  }
  if (text.length > STANDING_LIMIT) return unavailable(name, 'too-large');
  const byteLength = Buffer.byteLength(text);
  if (byteLength > STANDING_LIMIT) return unavailable(name, 'too-large');
  if (reported !== byteLength) return transient(name);
  if (text.trim()) return loaded(name, text, byteLength);
  return blank(name, text, byteLength);
}

function loaded(name: StandingName, text: string, byteLength: number): ObservedFile {
  return {
    name,
    status: 'loaded',
    text,
    detail: `${name} loaded.`,
    sourceVersion: bodyVersion(text),
    byteLength,
  };
}

/** Visible text is empty. The version still covers the original whitespace bytes. */
function blank(name: StandingName, original: string, byteLength: number): ObservedFile {
  return {
    name,
    status: 'blank',
    text: '',
    detail: `${name} is ${ioDetail('blank')}`,
    sourceVersion: bodyVersion(original),
    byteLength,
  };
}

/** Zero means the body length is unavailable. It is not a disk size and not a token cost. */
function unavailable(name: StandingName, status: StandingStableFailure): ObservedFile {
  return {
    name,
    status,
    text: '',
    detail: `${name} is ${ioDetail(status)}`,
    sourceVersion: failureVersion(status),
    byteLength: 0,
  };
}

function transient(name: StandingName): ObservedFile {
  return {
    name,
    status: 'changed-during-read',
    text: '',
    detail: '',
    sourceVersion: failureVersion('changed-during-read'),
    byteLength: 0,
  };
}

function publishable(first: readonly ObservedFile[], second: readonly ObservedFile[]): boolean {
  if (first.length !== STANDING_FILES.length || second.length !== STANDING_FILES.length) return false;
  for (let index = 0; index < STANDING_FILES.length; index += 1) {
    const left = first[index];
    const right = second[index];
    const expected = STANDING_FILES[index];
    if (!left || !right || !expected) return false;
    if (left.name !== expected || right.name !== expected) return false;
    if (left.status === 'changed-during-read' || right.status === 'changed-during-read') return false;
    if (left.name !== right.name || left.status !== right.status || left.sourceVersion !== right.sourceVersion || left.byteLength !== right.byteLength) {
      return false;
    }
  }
  return true;
}

function toPublished(file: ObservedFile): StandingFileStateV1 {
  if (file.status === 'loaded') {
    return {
      name: file.name,
      status: 'loaded',
      text: file.text,
      detail: file.detail,
      sourceVersion: file.sourceVersion,
      byteLength: file.byteLength,
    };
  }
  if (file.status === 'changed-during-read') throw new StandingStoreError('CONFIG_CHANGED');
  return {
    name: file.name,
    status: file.status,
    text: '',
    detail: file.detail,
    sourceVersion: file.sourceVersion,
    byteLength: file.byteLength,
  };
}

function asSet(files: readonly StandingFileStateV1[]): StandingSnapshotV1['files'] {
  const identity = files[0];
  const soul = files[1];
  const user = files[2];
  const tools = files[3];
  const agents = files[4];
  if (
    identity?.name !== 'IDENTITY.md'
    || soul?.name !== 'SOUL.md'
    || user?.name !== 'USER.md'
    || tools?.name !== 'TOOLS.md'
    || agents?.name !== 'AGENTS.md'
  ) throw new StandingStoreError('STANDING_UNAVAILABLE');
  return [identity, soul, user, tools, agents] as StandingSnapshotV1['files'];
}

function projectStandingIdentity(files: readonly { name: string; status: string; text: string; detail: string }[]): IdentityProjection {
  const identity = files.find(file => file.name === 'IDENTITY.md');
  let name = DEFAULT_NAME;
  let tone: Tone = DEFAULT_TONE;
  let nameDetail = `product default because ${identity?.detail ?? 'IDENTITY.md is missing.'}`;
  let toneDetail = nameDetail;
  const problems = files.filter(file => file.status !== 'loaded').map(file => file.detail);
  if (identity?.status === 'loaded') {
    const parsed = parseIdentity(identity.text);
    if (parsed.name) {
      name = parsed.name;
      nameDetail = 'from standing/IDENTITY.md';
    } else {
      nameDetail = `product default because ${parsed.nameProblem}`;
      problems.push(parsed.nameProblem);
    }
    if (parsed.tone) {
      tone = parsed.tone;
      toneDetail = 'from standing/IDENTITY.md';
    } else {
      toneDetail = `product default because ${parsed.toneProblem}`;
      problems.push(parsed.toneProblem);
    }
  }
  return {
    name,
    tone,
    nameDetail,
    toneDetail,
    defaultTemplate: identity?.status === 'loaded' && identity.text.trim() === STANDING_TEMPLATES['IDENTITY.md'].trim(),
    problems,
  };
}

function bodyVersion(text: string): string {
  return digest(['kleio-standing-body-v1', text]);
}

function failureVersion(status: string): string {
  return digest(['kleio-standing-unavailable-v1', status]);
}

function collectionVersion(files: readonly { name: string; status: string; sourceVersion: string; byteLength: number }[]): string {
  const parts = ['kleio-standing-set-v1'];
  for (const file of files) parts.push(file.name, file.status, file.sourceVersion, String(file.byteLength));
  return digest(parts);
}

function digest(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)), 'utf8');
    hash.update('\0');
    hash.update(part, 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const nested = record[key];
    if (nested !== null && typeof nested === 'object') freezeDeep(nested);
  }
  return Object.freeze(value);
}
