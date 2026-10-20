import { createHash } from 'node:crypto';
import { isAlias, parseDocument, visit } from 'yaml';
import type { ContextScope } from '../context-contracts/context.ts';
import type { ToolProfile } from '../context-contracts/tools.ts';

export const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const KINDS = ['conversation', 'research', 'memory', 'review', 'legacy-research'];
export interface SkillMetadata {
  readonly skillId: string; readonly name: string; readonly description: string; readonly skillVersion: string;
  readonly requiresTools: readonly string[]; readonly toolBindings: Readonly<Record<string, string>>;
  readonly executionKinds: readonly ToolProfile[];
}
export interface SkillDiagnostic { readonly skillId?: string; readonly code: string }
export interface SkillCatalogSnapshot {
  readonly schemaVersion: 1; readonly snapshotId: string; readonly scope: ContextScope; readonly profile: ToolProfile;
  readonly skills: readonly SkillMetadata[]; readonly diagnostics: readonly SkillDiagnostic[];
}
export interface SkillConstraints { enabled?: boolean; requiresTools?: string[]; toolBindings?: Record<string,string>; executionKinds?: ToolProfile[] }
export class SkillStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SkillStoreError'; }
}
export function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SkillStoreError('INVALID_METADATA');
  return value as Record<string,unknown>;
}
export function constraints(value: unknown, index = false): SkillConstraints {
  const input = object(value);
  for (const key of Object.keys(input)) if (!(index ? ['id','enabled','requiresTools','toolBindings'] : ['requiresTools','toolBindings','executionKinds']).includes(key)) throw new SkillStoreError('INVALID_PERMISSION_FIELDS');
  const result: SkillConstraints = {};
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new SkillStoreError('INVALID_METADATA');
    result.enabled = input.enabled;
  }
  if ('requiresTools' in input) {
    if (!Array.isArray(input.requiresTools) || input.requiresTools.length > 64 || input.requiresTools.some(x => typeof x !== 'string' || !TOOL.test(x))) throw new SkillStoreError('INVALID_PERMISSION_FIELDS');
    result.requiresTools = [...new Set(input.requiresTools as string[])];
  }
  if ('toolBindings' in input) {
    const bindings = object(input.toolBindings);
    if (Object.keys(bindings).length > 64) throw new SkillStoreError('INVALID_PERMISSION_FIELDS');
    result.toolBindings = Object.create(null) as Record<string,string>;
    for (const [key, binding] of Object.entries(bindings)) {
      if (!TOOL.test(key) || typeof binding !== 'string' || !TOOL.test(binding)) throw new SkillStoreError('INVALID_PERMISSION_FIELDS');
      result.toolBindings[key] = binding;
    }
  }
  if ('executionKinds' in input) {
    if (!Array.isArray(input.executionKinds) || input.executionKinds.some(x => !KINDS.includes(x))) throw new SkillStoreError('INVALID_PERMISSION_FIELDS');
    result.executionKinds = [...new Set(input.executionKinds as ToolProfile[])];
  }
  return result;
}
export function parseSkill(text: string, skillId: string): SkillMetadata {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g,'\n');
  if (!normalized.startsWith('---\n')) throw new SkillStoreError('INVALID_FRONTMATTER');
  const end = normalized.indexOf('\n---\n',4);
  if (end < 0 || !normalized.slice(end + 5).trim()) throw new SkillStoreError('INVALID_FRONTMATTER');
  const doc = parseDocument(normalized.slice(4,end), { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new SkillStoreError('INVALID_YAML');
  visit(doc, (_, node) => { if (isAlias(node) || (typeof node === 'object' && node !== null && 'tag' in node && node.tag)) throw new SkillStoreError('INVALID_YAML'); });
  const value = object(doc.toJS({ maxAliasCount: 0 }));
  // Standard descriptive metadata is inert; permission-like top-level extensions are refused.
  for (const key of Object.keys(value)) if (!['id','name','description','metadata','license','compatibility','allowed-tools'].includes(key)) throw new SkillStoreError('INVALID_METADATA');
  if ('allowed-tools' in value) throw new SkillStoreError('INVALID_PERMISSION_FIELDS');
  if ('id' in value && value.id !== skillId) throw new SkillStoreError('ID_MISMATCH');
  const name = value.name ?? value.id;
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\u0000-\u001f]/.test(name)) throw new SkillStoreError('INVALID_METADATA');
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1024 || /[\u0000-\u0008\u000b-\u001f]/.test(value.description)) throw new SkillStoreError('INVALID_METADATA');
  const metadata = value.metadata === undefined ? {} : object(value.metadata);
  const parsed = metadata.kleio === undefined ? {} : constraints(metadata.kleio);
  return freeze({ skillId, name, description: value.description, skillVersion: digest(text), requiresTools: parsed.requiresTools ?? [], toolBindings: parsed.toolBindings ?? {}, executionKinds: parsed.executionKinds ?? KINDS as ToolProfile[] });
}
export function parseSkillIndex(text: string): Map<string, SkillConstraints> {
  let input: Record<string,unknown>;
  try { input = object(JSON.parse(text)); } catch { throw new SkillStoreError('INVALID_INDEX'); }
  if (input.version !== 1 || !Array.isArray(input.skills) || input.skills.length > 256 || Object.keys(input).some(k => !['version','skills'].includes(k))) throw new SkillStoreError('INVALID_INDEX');
  const result = new Map<string,SkillConstraints>();
  for (const item of input.skills) {
    const record = object(item);
    if (typeof record.id !== 'string' || !SKILL_ID.test(record.id) || result.has(record.id)) throw new SkillStoreError('INVALID_INDEX');
    result.set(record.id, constraints(record, true));
  }
  return result;
}
