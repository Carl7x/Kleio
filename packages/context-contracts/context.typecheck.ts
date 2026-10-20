/**
 * Compile-time fixtures for the G3.1 context contract.
 * Positive values are built and read. Rejected writes live in uncalled functions
 * so loading this module does not apply them. Runtime tsc includes this file.
 */
import { STANDING_FILES, TONES, type StandingFileState, type StandingName as LegacyStandingName, type StandingSnapshot, type Tone } from '../product-context/standing.ts';
import type { IoReason } from '../product-context/files.ts';
import {
  CONFIG_CHANGED,
  CONTEXT_SCHEMA_VERSION,
  CONTEXT_SCOPE_MISMATCH,
  LOCAL_SCOPE_ID,
  STANDING_NAMES,
  STANDING_TONES,
  type ConfigChangedCode,
  type ContextPart,
  type ContextScope,
  type ContextScopeMismatchCode,
  type ProductPolicyContent,
  type ProductPolicyPart,
  type StandingContextPart,
  type StandingFileSetV1,
  type StandingFileStateV1,
  type StandingName,
  type StandingPublishedStatus,
  type StandingReadFailure,
  type StandingReadStatus,
  type StandingSnapshotV1,
  type StandingTone,
  type LegacyIoReason,
} from './context.ts';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type _Schema = Assert<Equal<typeof CONTEXT_SCHEMA_VERSION, 1>>;
type _Names = Assert<Equal<typeof STANDING_NAMES, typeof STANDING_FILES>>;
type _Name = Assert<Equal<StandingName, LegacyStandingName>>;
type _Tones = Assert<Equal<typeof STANDING_TONES, typeof TONES>>;
type _Tone = Assert<Equal<StandingTone, Tone>>;
type _Io = Assert<Equal<LegacyIoReason, IoReason>>;
type _Published = Assert<Equal<StandingPublishedStatus, 'loaded' | 'blank' | IoReason | 'invalid-encoding'>>;
type _ReadFailure = Assert<Equal<StandingReadFailure, IoReason | 'invalid-encoding' | 'changed-during-read'>>;
type _ReadStatus = Assert<Equal<StandingReadStatus, StandingPublishedStatus | 'changed-during-read'>>;
type _TransientHidden = Assert<Equal<Extract<StandingPublishedStatus, 'changed-during-read'>, never>>;
type _StoreCodesAreNotFileStatus = Assert<Equal<
  Extract<StandingPublishedStatus | StandingReadFailure, ContextScopeMismatchCode | ConfigChangedCode>,
  never
>>;
type _Mismatch = Assert<Equal<typeof CONTEXT_SCOPE_MISMATCH, 'CONTEXT_SCOPE_MISMATCH'>>;
type _Changed = Assert<Equal<typeof CONFIG_CHANGED, 'CONFIG_CHANGED'>>;

type PartKeys = 'schemaVersion' | 'id' | 'scope' | 'kind' | 'authority' | 'sourceRef' | 'sourceVersion' | 'required' | 'content';
type _PolicyKeys = Assert<Equal<keyof ProductPolicyPart, PartKeys>>;
type _StandingKeys = Assert<Equal<keyof StandingContextPart, PartKeys>>;
type _SnapshotKeys = Assert<Equal<
  keyof StandingSnapshotV1,
  'schemaVersion' | 'scopeId' | 'snapshotId' | 'sourceVersion' | 'files' | 'name' | 'tone' | 'nameDetail' | 'toneDetail' | 'defaultTemplate' | 'problems'
>>;
type _FileKeys = Assert<Equal<keyof StandingFileStateV1, 'name' | 'status' | 'text' | 'detail' | 'sourceVersion' | 'byteLength'>>;
type _ScopeKeys = Assert<Equal<keyof ContextScope, 'scopeId' | 'executionId' | 'conversationId' | 'workId'>>;
type _NoDirectory = Assert<Equal<'dataDirectory' extends keyof ContextScope ? true : false, false>>;
type _NoTokens = Assert<Equal<'estimatedTokens' extends keyof ProductPolicyPart | keyof StandingContextPart | keyof StandingSnapshotV1 ? true : false, false>>;
type _NoTools = Assert<Equal<'tools' extends keyof StandingContextPart | keyof StandingSnapshotV1 | keyof ProductPolicyPart ? true : false, false>>;
type _Union = Assert<Equal<ContextPart, ProductPolicyPart | StandingContextPart>>;
type _PolicyKind = Assert<Equal<ProductPolicyPart['kind'], 'policy'>>;
type _PolicyAuthority = Assert<Equal<ProductPolicyPart['authority'], 'product-policy'>>;
type _PolicyRef = Assert<Equal<ProductPolicyPart['sourceRef'], 'product-policy'>>;
type _StandingKind = Assert<Equal<StandingContextPart['kind'], 'standing'>>;
type _StandingAuthority = Assert<Equal<StandingContextPart['authority'], 'user-config'>>;
type _StandingRef = Assert<Equal<StandingContextPart['sourceRef'], 'standing'>>;
type _Required = Assert<Equal<ContextPart['required'], true>>;
type _PartSchema = Assert<Equal<ContextPart['schemaVersion'], 1>>;
type _ByKind = Assert<Equal<Extract<ContextPart, { kind: 'policy' }>, ProductPolicyPart>>;
type _ByAuthority = Assert<Equal<Extract<ContextPart, { authority: 'user-config' }>, StandingContextPart>>;
type _PolicyContent = Assert<Equal<ProductPolicyPart['content'], ProductPolicyContent>>;
type _StandingContent = Assert<Equal<StandingContextPart['content'], StandingSnapshotV1>>;
type _Five = Assert<Equal<StandingFileSetV1['length'], 5>>;
type _LoadedText = Assert<Equal<Extract<StandingFileStateV1, { status: 'loaded' }>['text'], string>>;
type FileShape<Status extends string, Text extends string> = {
  name: 'SOUL.md';
  status: Status;
  text: Text;
  detail: string;
  sourceVersion: string;
  byteLength: number;
};
type _BlankOk = Assert<FileShape<'blank', ''> extends StandingFileStateV1 ? true : false>;
type _BlankHidden = Assert<FileShape<'blank', 'notes'> extends StandingFileStateV1 ? false : true>;
type _EncodingOk = Assert<FileShape<'invalid-encoding', ''> extends StandingFileStateV1 ? true : false>;
type _EncodingHidden = Assert<FileShape<'invalid-encoding', 'x'> extends StandingFileStateV1 ? false : true>;
type _TransientShape = Assert<FileShape<'changed-during-read', ''> extends StandingFileStateV1 ? false : true>;
type _ScopeId = Assert<Equal<ContextScope['scopeId'], string>>;
type _Execution = Assert<Equal<ContextScope['executionId'], string>>;
type _Conversation = Assert<Equal<ContextScope['conversationId'], string | undefined>>;
type _Work = Assert<Equal<ContextScope['workId'], string | undefined>>;

function loadedFile<Name extends StandingName>(
  name: Name,
  text: string,
  detail: string,
  sourceVersion: string,
  byteLength: number,
): StandingFileStateV1<Name> {
  return { name, status: 'loaded', text, detail, sourceVersion, byteLength };
}

function unpublishedFile<Name extends StandingName>(
  name: Name,
  status: Exclude<StandingPublishedStatus, 'loaded'>,
  detail: string,
  sourceVersion: string,
  byteLength: number,
): StandingFileStateV1<Name> {
  return { name, status, text: '', detail, sourceVersion, byteLength };
}

function legacyIdentity(snapshot: StandingSnapshotV1): Pick<StandingSnapshot, 'name' | 'tone' | 'nameDetail' | 'toneDetail' | 'defaultTemplate'> {
  return {
    name: snapshot.name,
    tone: snapshot.tone,
    nameDetail: snapshot.nameDetail,
    toneDetail: snapshot.toneDetail,
    defaultTemplate: snapshot.defaultTemplate,
  };
}

function legacyFile(file: StandingFileStateV1): Pick<StandingFileState, 'name' | 'text' | 'detail'> {
  return { name: file.name, text: file.text, detail: file.detail };
}

function publishedText(file: StandingFileStateV1): string {
  if (file.status === 'loaded') return file.text;
  const empty: '' = file.text;
  return empty;
}

function textOf(part: ContextPart): string {
  if (part.kind === 'policy') {
    const authority: 'product-policy' = part.authority;
    const sourceRef: 'product-policy' = part.sourceRef;
    return `${authority}\n${sourceRef}\n${part.content.policyId}\n${part.content.text}`;
  }
  const authority: 'user-config' = part.authority;
  const sourceRef: 'standing' = part.sourceRef;
  return `${authority}\n${sourceRef}\n${part.content.snapshotId}\n${part.content.name}\n${part.content.tone}`;
}

function positiveParts(): readonly [ProductPolicyPart, StandingContextPart] {
  const executionScope: ContextScope = {
    scopeId: LOCAL_SCOPE_ID,
    executionId: 'exec-1',
    conversationId: 'conv-1',
  };
  const workScope: ContextScope = {
    scopeId: LOCAL_SCOPE_ID,
    executionId: 'exec-1',
    conversationId: 'conv-1',
    workId: 'work-1',
  };
  const files: StandingFileSetV1 = [
    loadedFile('IDENTITY.md', 'Name: Kleio\n', 'IDENTITY.md loaded.', 'ver-identity', 12),
    unpublishedFile('SOUL.md', 'blank', 'SOUL.md is blank. The product default is used.', 'ver-soul', 0),
    unpublishedFile('USER.md', 'missing', 'USER.md is missing. The product default is used.', 'ver-user', 0),
    unpublishedFile('TOOLS.md', 'too-large', 'TOOLS.md is over the size limit and was not loaded.', 'ver-tools', 16385),
    unpublishedFile('AGENTS.md', 'invalid-encoding', 'AGENTS.md is not valid UTF-8 and was not loaded.', 'ver-agents', 4),
  ];
  const snapshot: StandingSnapshotV1 = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    scopeId: executionScope.scopeId,
    snapshotId: 'snapshot-1',
    sourceVersion: 'set-version-1',
    files,
    name: 'Kleio',
    tone: 'warm',
    nameDetail: 'from standing/IDENTITY.md',
    toneDetail: 'from standing/IDENTITY.md',
    defaultTemplate: false,
    problems: [files[1].detail, files[2].detail, files[3].detail, files[4].detail],
  };
  const identity = legacyIdentity(snapshot);
  const identityFile = legacyFile(files[0]);
  const standing: StandingContextPart = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    id: 'part-standing-1',
    scope: executionScope,
    kind: 'standing',
    authority: 'user-config',
    sourceRef: 'standing',
    sourceVersion: snapshot.sourceVersion,
    required: true,
    content: snapshot,
  };
  const policy: ProductPolicyPart = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    id: 'part-policy-1',
    scope: workScope,
    kind: 'policy',
    authority: 'product-policy',
    sourceRef: 'product-policy',
    sourceVersion: 'policy-version-1',
    required: true,
    content: { policyId: 'product-rules', text: 'Product rules outrank standing notes.' },
  };
  void identity.name;
  void identityFile.name;
  void textOf(policy);
  void textOf(standing);
  void files.map(publishedText);
  return [policy, standing];
}

const [policyPart, standingPart] = positiveParts();
void policyPart.required;
void standingPart.content.files[0].byteLength;

function rejectWrongAuthority(scope: ContextScope, content: StandingSnapshotV1): void {
  const _standing: StandingContextPart = {
    schemaVersion: 1,
    id: 'part-standing',
    scope,
    kind: 'standing',
    // @ts-expect-error standing authority is user-config
    authority: 'product-policy',
    sourceRef: 'standing',
    sourceVersion: content.sourceVersion,
    required: true,
    content,
  };
  void _standing;
}

function rejectPolicyAuthority(scope: ContextScope): void {
  const _policy: ProductPolicyPart = {
    schemaVersion: 1,
    id: 'part-policy',
    scope,
    kind: 'policy',
    // @ts-expect-error policy authority is product-policy
    authority: 'user-config',
    sourceRef: 'product-policy',
    sourceVersion: 'policy-version',
    required: true,
    content: { policyId: 'product-rules', text: 'rules' },
  };
  void _policy;
}

function rejectPolicyContentOnStanding(scope: ContextScope): void {
  const _standing: StandingContextPart = {
    schemaVersion: 1,
    id: 'part-standing',
    scope,
    kind: 'standing',
    authority: 'user-config',
    sourceRef: 'standing',
    sourceVersion: 'set-version',
    required: true,
    // @ts-expect-error standing content is a snapshot, not policy text
    content: { policyId: 'product-rules', text: 'rules' },
  };
  void _standing;
}

function rejectStandingContentOnPolicy(scope: ContextScope, content: StandingSnapshotV1): void {
  const _policy: ProductPolicyPart = {
    schemaVersion: 1,
    id: 'part-policy',
    scope,
    kind: 'policy',
    authority: 'product-policy',
    sourceRef: 'product-policy',
    sourceVersion: 'policy-version',
    required: true,
    // @ts-expect-error policy content is policyId and text, not a standing snapshot
    content,
  };
  void _policy;
}

function rejectOpenKind(scope: ContextScope, content: StandingSnapshotV1): void {
  const kind: string = 'standing';
  const _standing: StandingContextPart = {
    schemaVersion: 1,
    id: 'part-standing',
    scope,
    // @ts-expect-error kind is the literal standing, not an open string
    kind,
    authority: 'user-config',
    sourceRef: 'standing',
    sourceVersion: content.sourceVersion,
    required: true,
    content,
  };
  void _standing;
}

function rejectNestedMutation(standing: StandingContextPart, policy: ProductPolicyPart): void {
  // @ts-expect-error published snapshot fields are readonly
  standing.content.name = 'Other';
  // @ts-expect-error published tone is readonly
  standing.content.tone = 'concise';
  // @ts-expect-error problem diagnostics are a readonly list
  standing.content.problems.push('added');
  // @ts-expect-error problem diagnostics cannot be overwritten
  standing.content.problems[0] = 'added';
  // @ts-expect-error published file fields are readonly
  standing.content.files[0].detail = 'changed';
  // @ts-expect-error per-file byte length is readonly
  standing.content.files[0].byteLength = 1;
  // @ts-expect-error the five-file set is readonly
  standing.content.files = standing.content.files;
  // @ts-expect-error trusted scope fields are readonly
  standing.scope.executionId = 'exec-2';
  // @ts-expect-error part content is readonly
  standing.content = standing.content;
  // @ts-expect-error policy text is readonly
  policy.content.text = 'changed';
  // @ts-expect-error policy id is readonly
  policy.content.policyId = 'other';
}

function rejectTransientPublication(): void {
  const _file: StandingFileStateV1 = {
    name: 'USER.md',
    // @ts-expect-error changed-during-read is transient and is never a published file status
    status: 'changed-during-read',
    text: '',
    detail: 'changed while reading',
    sourceVersion: 'ver-user',
    byteLength: 0,
  };
  void _file;
}

function rejectVisibleFailureText(): void {
  // @ts-expect-error blank and failed files publish empty text
  const _file: StandingFileStateV1 = {
    name: 'SOUL.md',
    status: 'blank',
    text: 'notes',
    detail: 'blank',
    sourceVersion: 'ver-soul',
    byteLength: 0,
  };
  void _file;
}

function rejectAbsolutePath(): void {
  const _file: StandingFileStateV1 = {
    name: 'IDENTITY.md',
    status: 'loaded',
    text: 'name',
    detail: 'loaded',
    sourceVersion: 'ver',
    byteLength: 4,
    // @ts-expect-error file state has no path, errno, or raw exception
    path: '/tmp/kleio/standing/IDENTITY.md',
  };
  void _file;
}

function rejectDataDirectory(): void {
  const _scope: ContextScope = {
    scopeId: LOCAL_SCOPE_ID,
    executionId: 'exec-1',
    // @ts-expect-error scope does not carry a data directory or credential
    dataDirectory: '/tmp/kleio',
  };
  void _scope;
}

function rejectUndefinedWork(): void {
  // @ts-expect-error an unknown workId is omitted, not assigned undefined
  const _scope: ContextScope = {
    scopeId: LOCAL_SCOPE_ID,
    executionId: 'exec-1',
    workId: undefined,
  };
  void _scope;
}

function rejectOptionalStanding(scope: ContextScope, content: StandingSnapshotV1): void {
  const _standing: StandingContextPart = {
    schemaVersion: 1,
    id: 'part-standing',
    scope,
    kind: 'standing',
    authority: 'user-config',
    sourceRef: 'standing',
    sourceVersion: content.sourceVersion,
    // @ts-expect-error parts in this schema are required
    required: false,
    content,
  };
  void _standing;
}

function rejectSchemaVersion(scope: ContextScope, content: StandingSnapshotV1): void {
  const _standing: StandingContextPart = {
    // @ts-expect-error schemaVersion is 1
    schemaVersion: 2,
    id: 'part-standing',
    scope,
    kind: 'standing',
    authority: 'user-config',
    sourceRef: 'standing',
    sourceVersion: content.sourceVersion,
    required: true,
    content,
  };
  void _standing;
}

function rejectTokenEstimate(policy: ProductPolicyPart): void {
  const _withTokens: ProductPolicyPart = {
    schemaVersion: policy.schemaVersion,
    id: policy.id,
    scope: policy.scope,
    kind: policy.kind,
    authority: policy.authority,
    sourceRef: policy.sourceRef,
    sourceVersion: policy.sourceVersion,
    required: policy.required,
    content: policy.content,
    // @ts-expect-error token estimates are not part of this contract
    estimatedTokens: 0,
  };
  void _withTokens;
}

function rejectToolGrant(scope: ContextScope, content: StandingSnapshotV1): void {
  const _standing: StandingContextPart = {
    schemaVersion: 1,
    id: 'part-standing',
    scope,
    kind: 'standing',
    authority: 'user-config',
    sourceRef: 'standing',
    sourceVersion: content.sourceVersion,
    required: true,
    content,
    // @ts-expect-error standing is user configuration, not a tool grant
    tools: ['shell'],
  };
  void _standing;
}

function rejectStandingFieldOnPolicy(part: ProductPolicyPart): string {
  // @ts-expect-error policy content has no standing identity fields
  return part.content.name;
}

function rejectPolicyFieldOnStanding(part: StandingContextPart): string {
  // @ts-expect-error standing content has no policyId
  return part.content.policyId;
}

void [
  rejectWrongAuthority,
  rejectPolicyAuthority,
  rejectPolicyContentOnStanding,
  rejectStandingContentOnPolicy,
  rejectOpenKind,
  rejectNestedMutation,
  rejectTransientPublication,
  rejectVisibleFailureText,
  rejectAbsolutePath,
  rejectDataDirectory,
  rejectUndefinedWork,
  rejectOptionalStanding,
  rejectSchemaVersion,
  rejectTokenEstimate,
  rejectToolGrant,
  rejectStandingFieldOnPolicy,
  rejectPolicyFieldOnStanding,
];
