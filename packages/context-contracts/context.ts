/**
 * Engine-neutral context parts.
 *
 * A trusted host supplies scope and configuration. Model arguments, skill text,
 * and sourceRef do not choose a scope and are not a data directory. These shapes
 * carry no credentials, tool grants, or token estimates. StandingStore copies and
 * freezes them when it publishes; this module does not read files or grant access.
 *
 * Codex keeps a frozen instruction snapshot apart from live permission grants
 * (StepContext) and records provenance on loaded instructions (LoadedAgentsMd).
 * The same split is these two parts: product policy versus user standing.
 */

export const CONTEXT_SCHEMA_VERSION = 1 as const;
export type ContextSchemaVersion = typeof CONTEXT_SCHEMA_VERSION;

/** Current single-user host scope id. An opaque id, not a filesystem path. */
export const LOCAL_SCOPE_ID = 'local' as const;

/** capture() rejects a scope that does not match the store before any file IO. */
export const CONTEXT_SCOPE_MISMATCH = 'CONTEXT_SCOPE_MISMATCH' as const;
export type ContextScopeMismatchCode = typeof CONTEXT_SCOPE_MISMATCH;

/**
 * The five-file set never stayed stable. Raised instead of publishing a snapshot.
 * Not a per-file status.
 */
export const CONFIG_CHANGED = 'CONFIG_CHANGED' as const;
export type ConfigChangedCode = typeof CONFIG_CHANGED;

export type ContextScope = {
  readonly scopeId: string;
  readonly executionId: string;
  readonly conversationId?: string;
  readonly workId?: string;
};

/** Fixed order for the five-file content version. Do not sort or drop a name. */
export const STANDING_NAMES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'AGENTS.md'] as const;
export type StandingName = (typeof STANDING_NAMES)[number];

export const STANDING_TONES = ['warm', 'concise', 'thoughtful'] as const;
export type StandingTone = (typeof STANDING_TONES)[number];

/**
 * Safe IO reasons already used by bounded file access.
 * Same strings as product-context IoReason. No paths, errno text, or file bodies.
 */
export const LEGACY_IO_REASONS = [
  'missing',
  'symlink',
  'not-file',
  'too-large',
  'escape',
  'path',
  'unreadable',
  'invalid-fields',
] as const;
export type LegacyIoReason = (typeof LEGACY_IO_REASONS)[number];

/** Stable failures that may be published with empty text, including strict UTF-8 refusal. */
export const STANDING_STABLE_FAILURES = [...LEGACY_IO_REASONS, 'invalid-encoding'] as const;
export type StandingStableFailure = (typeof STANDING_STABLE_FAILURES)[number];

/**
 * The file changed while it was being read. The loader retries the whole set and,
 * if that fails, reports CONFIG_CHANGED. A published file never uses this status.
 */
export const STANDING_TRANSIENT_READ_FAILURES = ['changed-during-read'] as const;
export type StandingTransientReadFailure = (typeof STANDING_TRANSIENT_READ_FAILURES)[number];

/** Codes a strict reader can return. Does not include loaded or blank. */
export type StandingReadFailure = StandingStableFailure | StandingTransientReadFailure;

/** Closed set of statuses a published file may carry. Order is not a version input. */
export const STANDING_PUBLISHED_STATUSES = ['loaded', 'blank', ...STANDING_STABLE_FAILURES] as const;
export type StandingPublishedStatus = (typeof STANDING_PUBLISHED_STATUSES)[number];

/**
 * What a collector may observe before it decides the set is stable.
 * Includes the transient read failure and the classification statuses loaded and blank.
 */
export type StandingReadStatus = StandingPublishedStatus | StandingTransientReadFailure;

type StandingFileBase<Name extends StandingName> = {
  readonly name: Name;
  /** Safe diagnostic. Not a path, a raw exception, or unpublished file text. */
  readonly detail: string;
  /** Per-file content identity. Status-only when the body is not published. Not mtime. */
  readonly sourceVersion: string;
  /** Observed byte length. Not a token estimate. */
  readonly byteLength: number;
};

/** Loaded files keep their text. Every other published status has empty text. */
export type StandingFileStateV1<Name extends StandingName = StandingName> =
  | (StandingFileBase<Name> & {
      readonly status: 'loaded';
      readonly text: string;
    })
  | (StandingFileBase<Name> & {
      readonly status: Exclude<StandingPublishedStatus, 'loaded'>;
      readonly text: '';
    });

/** Five files in STANDING_NAMES order. */
export type StandingFileSetV1 = readonly [
  StandingFileStateV1<'IDENTITY.md'>,
  StandingFileStateV1<'SOUL.md'>,
  StandingFileStateV1<'USER.md'>,
  StandingFileStateV1<'TOOLS.md'>,
  StandingFileStateV1<'AGENTS.md'>,
];

/**
 * One stable observation of standing, plus the legacy flat identity projection.
 * snapshotId identifies this capture. sourceVersion identifies the five-file content.
 * Identical content may share sourceVersion and still have different snapshot ids.
 */
export type StandingSnapshotV1 = {
  readonly schemaVersion: ContextSchemaVersion;
  readonly scopeId: string;
  /** Per-capture id. Not an input to sourceVersion. */
  readonly snapshotId: string;
  /** Content identity of the five files in STANDING_NAMES order. Not mtime and not a token count. */
  readonly sourceVersion: string;
  readonly files: StandingFileSetV1;
  readonly name: string;
  readonly tone: StandingTone;
  readonly nameDetail: string;
  readonly toneDetail: string;
  readonly defaultTemplate: boolean;
  readonly problems: readonly string[];
};

export type ProductPolicyContent = {
  readonly policyId: string;
  readonly text: string;
};

/**
 * Product policy text.
 * kind is the content class. authority is the trust level. sourceRef is a stable
 * provenance tag, not a path. Standing cannot satisfy this shape.
 */
export type ProductPolicyPart = {
  readonly schemaVersion: ContextSchemaVersion;
  readonly id: string;
  readonly scope: ContextScope;
  readonly kind: 'policy';
  readonly authority: 'product-policy';
  readonly sourceRef: 'product-policy';
  readonly sourceVersion: string;
  readonly required: true;
  readonly content: ProductPolicyContent;
};

/**
 * User standing captured for one scope.
 * Configuration only: this part does not grant tools or raise product policy.
 */
export type StandingContextPart = {
  readonly schemaVersion: ContextSchemaVersion;
  readonly id: string;
  readonly scope: ContextScope;
  readonly kind: 'standing';
  readonly authority: 'user-config';
  readonly sourceRef: 'standing';
  readonly sourceVersion: string;
  readonly required: true;
  readonly content: StandingSnapshotV1;
};

/** Closed union. Evidence, history, skills, and tools are later parts, not an open basket. */
export type ContextPart = ProductPolicyPart | StandingContextPart;

export type ContextPartKind = ContextPart['kind'];
export type ContextPartAuthority = ContextPart['authority'];
export type ContextPartSourceRef = ContextPart['sourceRef'];
