import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ContextScope } from '../context-contracts/context.ts';
import type { EffectiveToolSet } from '../context-contracts/tools.ts';
import { readBoundedStrict, writeBounded, createBoundedIfAbsent } from './files.ts';
import { digest, freeze, parseSkill, parseSkillIndex, SKILL_ID, SkillStoreError, type SkillCatalogSnapshot, type SkillConstraints, type SkillDiagnostic, type SkillMetadata } from './skill-catalog.ts';
export { SkillStoreError } from './skill-catalog.ts';
export interface SkillResourceLocator { readonly resource: string; readonly sourceVersion: string; readonly byteLength: number }
export interface SkillResource {
  readonly sourceRef: string; readonly sourceVersion: string; readonly text: string;
  readonly metadata: { readonly skillId: string; readonly skillVersion: string; readonly resource: string; readonly byteLength: number; readonly relatedResources: readonly SkillResourceLocator[] };
}
export interface SkillPolicy { readonly disabledIds: readonly string[]; readonly sourceVersion: string }
export interface SkillStoreOptions { readonly dataDirectory: string; readonly scopeId: string }
type File = { resource: string; text: string; sourceVersion: string; byteLength: number };
type State = { packages: Map<string,readonly File[]>; stale: Set<string>; bytes: number };
const FILE_LIMIT = 64 * 1024, PACKAGE_LIMIT = 512 * 1024, CACHE_LIMIT = 8 * 1024 * 1024;
const TEXT = new Set(['.md','.txt','.json','.yaml','.yml']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
function fail(code: string): never { throw new SkillStoreError(code); }
function code(error: unknown): string { return error instanceof SkillStoreError ? error.code : 'UNREADABLE'; }
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
/** Snapshot authority is owned by this store, not by public structural metadata. */
export class SkillStore {
  readonly #root: string; readonly #scopeId: string;
  readonly #states = new WeakMap<SkillCatalogSnapshot,State>();
  constructor(options: SkillStoreOptions) { const root = resolve(options.dataDirectory); if (lstatSync(root).isSymbolicLink()) fail('UNSAFE_PATH'); this.#root = realpathSync(root); this.#scopeId = options.scopeId; }
  /** Whole-index byte identity; callers compare disabledIds when detecting revocation. */
  readPolicy(): SkillPolicy {
    const input = this.#policyInput();
    return this.#policyView(input.text, input.overrides);
  }
  /**
   * Synchronous trusted configuration IO only; the Host owns policy epochs.
   * Finite before/after observations detect ordinary concurrent edits. Atomic rename
   * does not provide an OS transaction against equal-privilege directory writers.
   */
  setEnabled(skillId: string, enabled: boolean): SkillPolicy {
    if (typeof skillId !== 'string' || !SKILL_ID.test(skillId) || typeof enabled !== 'boolean') fail('INVALID_POLICY_ARGUMENTS');
    const before = this.#policyInput();
    const index = before.text === undefined ? { version: 1, skills: [] as Record<string, unknown>[] }
      : JSON.parse(before.text) as { version: number; skills: Record<string, unknown>[] };
    const target = index.skills.find(entry => entry.id === skillId);
    if (target?.enabled === enabled) return this.#policyView(before.text, before.overrides);
    if (target) target.enabled = enabled;
    else index.skills.push({ id: skillId, enabled });
    const text = JSON.stringify(index, null, 2) + '\n';
    if (Buffer.byteLength(text) > 32 * 1024) fail('TOO_LARGE');
    // Validate the exact candidate before touching disk; never repair malformed input.
    parseSkillIndex(text);
    if (this.#policyInput().text !== before.text) fail('CONFIG_CHANGED');
    if (before.text === undefined) {
      const result = createBoundedIfAbsent(this.#root, ['skills-index.json'], text, 32 * 1024);
      if (!result.ok) fail(result.reason.toUpperCase().replaceAll('-', '_'));
      if (!result.created) fail('CONFIG_CHANGED');
    } else {
      const result = writeBounded(this.#root, ['skills-index.json'], text, 32 * 1024);
      if (!result.ok) fail(result.reason.toUpperCase().replaceAll('-', '_'));
    }
    const after = this.#policyInput();
    if (after.text !== text || after.overrides.get(skillId)?.enabled !== enabled) fail('CONFIG_CHANGED');
    return this.#policyView(after.text, after.overrides);
  }
  #policyInput(): { text: string | undefined; overrides: Map<string, SkillConstraints> } {
    try { this.#guard([]); } catch (error) { fail(code(error)); }
    let text: string;
    try { text = this.#read(['skills-index.json'], 32 * 1024).text; }
    catch (error) { if (missing(error)) return { text: undefined, overrides: new Map() }; fail(code(error)); }
    try { return { text, overrides: parseSkillIndex(text) }; }
    catch (error) { fail(code(error)); }
  }
  #policyView(text: string | undefined, overrides: Map<string, SkillConstraints>): SkillPolicy {
    return freeze({ disabledIds: [...overrides].filter(([, value]) => value.enabled === false).map(([id]) => id).sort(),
      sourceVersion: digest(text === undefined ? 'kleio-skill-index-missing-v1' : text) });
  }
  capture(scope: ContextScope, effectiveTools: EffectiveToolSet): SkillCatalogSnapshot {
    if (!scope || scope.scopeId !== this.#scopeId || !scope.executionId || scope.scopeId !== effectiveTools.scope.scopeId || scope.executionId !== effectiveTools.scope.executionId || scope.conversationId !== effectiveTools.scope.conversationId || scope.workId !== effectiveTools.scope.workId) fail('CONTEXT_SCOPE_MISMATCH');
    const owned: ContextScope = { scopeId: scope.scopeId, executionId: scope.executionId, ...(scope.conversationId !== undefined ? { conversationId: scope.conversationId } : {}), ...(scope.workId !== undefined ? {workId:scope.workId} : {}) };
    const diagnostics: SkillDiagnostic[] = [], skills: SkillMetadata[] = [];
    let overrides: Map<string,SkillConstraints>;
    try { overrides = this.#index(); } catch (error) {
      diagnostics.push({code:code(error)}); return this.#publish(owned,effectiveTools,skills,diagnostics);
    }
    let names: string[];
    try { names = this.#list(['skills']); } catch (error) {
      if (!missing(error)) diagnostics.push({code:code(error)});
      return this.#publish(owned,effectiveTools,skills,diagnostics);
    }
    if (names.length > 256) { diagnostics.push({code:'CATALOG_LIMIT'}); return this.#publish(owned,effectiveTools,skills,diagnostics); }
    const available = new Set(effectiveTools.tools.map(x => x.name));
    for (const skillId of names) {
      try {
        if (!SKILL_ID.test(skillId)) fail('INVALID_SKILL_ID');
        const override = overrides.get(skillId);
        if (override?.enabled === false) { diagnostics.push({skillId,code:'DISABLED'}); continue; }
        const parsed = parseSkill(this.#read(['skills',skillId,'SKILL.md'],FILE_LIMIT).text,skillId);
        // Overrides add constraints; they cannot weaken frontmatter requirements.
        const requiresTools = [...new Set([...parsed.requiresTools,...(override?.requiresTools ?? [])])];
        const toolBindings = {...parsed.toolBindings,...override?.toolBindings};
        if (!parsed.executionKinds.includes(effectiveTools.profile) || requiresTools.some(x => !available.has(x))) fail('INELIGIBLE');
        for (const binding of Object.values(toolBindings)) if (!effectiveTools.registeredNames.includes(binding)) fail('INVALID_TOOL_BINDING');
        skills.push(freeze({...parsed,requiresTools,toolBindings}));
      } catch (error) { diagnostics.push({skillId,code:code(error)}); }
    }
    return this.#publish(owned,effectiveTools,skills,diagnostics);
  }
  #publish(scope: ContextScope, tools: EffectiveToolSet, skills: SkillMetadata[], diagnostics: SkillDiagnostic[]): SkillCatalogSnapshot {
    const snapshot = freeze({schemaVersion:1 as const,snapshotId:randomUUID(),scope,profile:tools.profile,skills,diagnostics});
    this.#states.set(snapshot,{packages:new Map(),stale:new Set(),bytes:0}); return snapshot;
  }
  readResource(snapshot: SkillCatalogSnapshot, skillId: string, expectedVersion: string, resource = 'SKILL.md'): SkillResource {
    const state = this.#states.get(snapshot); if (!state) fail('INVALID_SNAPSHOT');
    const skill = snapshot.skills.find(x => x.skillId === skillId); if (!skill) fail('SKILL_UNAVAILABLE');
    if (expectedVersion !== skill.skillVersion || state.stale.has(skillId)) fail('STALE_RESOURCE');
    if (this.#index().get(skillId)?.enabled === false) fail('SKILL_DISABLED');
    const parts = resource.split('/'); if (!parts.length || parts.some(x => !SEGMENT.test(x) || x === '.' || x === '..')) fail('INVALID_RESOURCE');
    let files = state.packages.get(skillId);
    if (!files) {
      try { if (digest(this.#read(['skills',skillId,'SKILL.md'],FILE_LIMIT).text) !== expectedVersion) { state.stale.add(skillId); fail('STALE_RESOURCE'); } }
      catch { state.stale.add(skillId); fail('STALE_RESOURCE'); }
      for (let attempt = 0; attempt < 2 && !files; attempt++) {
        try {
          const first = this.#package(skillId), second = this.#package(skillId);
          if (JSON.stringify(first) !== JSON.stringify(second)) continue;
          if (first.find(x => x.resource === 'SKILL.md')?.sourceVersion !== expectedVersion) { state.stale.add(skillId); fail('STALE_RESOURCE'); }
          files = freeze(first);
        } catch (error) { if (code(error) === 'CONFIG_CHANGED' && attempt === 0) continue; throw error; }
      }
      if (!files) fail('CONFIG_CHANGED');
      const bytes = files.reduce((n,x) => n+x.byteLength,0); if (state.bytes + bytes > CACHE_LIMIT) fail('CACHE_LIMIT');
      state.bytes += bytes; state.packages.set(skillId,files);
    }
    const file = files.find(x => x.resource === resource); if (!file) fail('RESOURCE_UNAVAILABLE');
    return freeze({sourceRef:`skill:${skillId}/${resource}`,sourceVersion:file.sourceVersion,text:file.text,metadata:{skillId,skillVersion:skill.skillVersion,resource,byteLength:file.byteLength,relatedResources:files.filter(x => x.resource !== resource).map(({resource,sourceVersion,byteLength}) => ({resource,sourceVersion,byteLength}))}});
  }
  release(snapshot: SkillCatalogSnapshot): void { this.#states.delete(snapshot); }
  #index(): Map<string,SkillConstraints> {
    try { return parseSkillIndex(this.#read(['skills-index.json'],32*1024).text); }
    catch (error) { if (missing(error)) return new Map(); throw error; }
  }
  #package(skillId: string): File[] {
    const files: File[] = []; let entries = 0, bytes = 0;
    const walk = (prefix: string[], depth: number) => {
      if (depth > 16) fail('PACKAGE_LIMIT');
      for (const name of this.#list(['skills',skillId,...prefix])) {
        if (++entries > 256 || !SEGMENT.test(name) || name === '.' || name === '..') fail('PACKAGE_LIMIT');
        const path = ['skills',skillId,...prefix,name]; const stat = this.#guard(path);
        if (stat.isDirectory()) { walk([...prefix,name],depth+1); continue; }
        if (!stat.isFile()) fail('UNSAFE_FILE');
        if (!TEXT.has(extname(name).toLowerCase())) continue;
        const read = this.#read(path,FILE_LIMIT); bytes += read.byteLength;
        if (files.length >= 64 || bytes > PACKAGE_LIMIT) fail('PACKAGE_LIMIT');
        files.push({resource:[...prefix,name].join('/'),...read,sourceVersion:digest(read.text)});
      }
    };
    walk([],0); return files;
  }
  /** Recheck every ancestor, hardlink count and path identity around strict fd IO. */
  #guard(parts: string[]) {
    let path = this.#root;
    const root = lstatSync(path,{bigint:true}); if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(path) !== path) fail('UNSAFE_PATH');
    let stat = root;
    for (const part of parts) {
      if (!SEGMENT.test(part) || part === '.' || part === '..') fail('INVALID_RESOURCE');
      path = join(path,part); stat = lstatSync(path,{bigint:true});
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) fail('UNSAFE_FILE');
      if (realpathSync(path) !== path) fail('UNSAFE_PATH');
    }
    return stat;
  }
  #list(parts: string[]): string[] {
    const before = this.#guard(parts); if (!before.isDirectory()) fail('UNSAFE_PATH');
    const names = readdirSync(join(this.#root,...parts)).sort();
    const after = this.#guard(parts); if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('CONFIG_CHANGED');
    return names;
  }
  #read(parts: string[], limit: number): {text:string;byteLength:number} {
    const before = this.#guard(parts); if (!before.isFile()) fail('UNSAFE_FILE');
    const result = readBoundedStrict(this.#root,parts,limit); if (!result.ok) fail(result.reason === 'changed-during-read' ? 'CONFIG_CHANGED' : result.reason.toUpperCase().replaceAll('-','_'));
    const after = this.#guard(parts);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('CONFIG_CHANGED');
    return {text:result.text,byteLength:result.byteLength};
  }
}
