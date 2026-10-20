import { createHash } from 'node:crypto';
import type { ContextScope } from '../context-contracts/context.ts';
import type { EffectiveToolSet, ExecutionKind, ToolDefinition, ToolDescriptor, ToolPolicy, ToolProfile } from '../context-contracts/tools.ts';
import { freezeCopy, toolAvailability, catalogAvailability } from '../product-context/tool-catalog.ts';
import { RuntimeError } from './contracts.ts';

export interface ToolInvocation {
  readonly scope: ContextScope;
  readonly executionId: string;
  readonly kind: ExecutionKind;
  readonly profile: ToolProfile;
  readonly signal: AbortSignal;
}
export type ToolHandler = (args: Record<string, unknown>, invocation: ToolInvocation) => Promise<unknown>;
export interface ToolBinding { readonly name: string; readonly handler: ToolHandler }

/** Definition content version, independent of object property insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function policyCopy(policy: ToolPolicy): ToolPolicy {
  if (typeof policy.memoryEnabled !== 'boolean' || typeof policy.searchConfigured !== 'boolean'
    || (policy.allowedTools !== undefined && (!Array.isArray(policy.allowedTools) || policy.allowedTools.some(name => typeof name !== 'string')))
    || (policy.disabledTools !== undefined && (!Array.isArray(policy.disabledTools) || policy.disabledTools.some(name => typeof name !== 'string')))) {
    throw new RuntimeError('tool_denied', 'Invalid tool policy.', 403);
  }
  // Copy only credential-free contract fields, never caller extensions.
  return freezeCopy({ memoryEnabled: policy.memoryEnabled, searchConfigured: policy.searchConfigured,
    ...(policy.allowedTools !== undefined ? { allowedTools: [...policy.allowedTools] } : {}),
    ...(policy.disabledTools !== undefined ? { disabledTools: [...policy.disabledTools] } : {}) });
}

/** Bound entries own authority; model projections and structural snapshots do not. */
export class ToolRegistry {
  readonly #catalog: readonly ToolDescriptor[];
  readonly #handlers: Map<string, ToolHandler>;
  readonly #captures = new WeakMap<EffectiveToolSet, ReadonlySet<string>>();
  readonly catalogVersion: string;

  constructor(catalog: readonly ToolDescriptor[], bindings: readonly ToolBinding[]) {
    const names = new Set<string>();
    for (const descriptor of catalog) {
      if (!descriptor.name || names.has(descriptor.name)) throw new Error('Duplicate or invalid tool definition.');
      names.add(descriptor.name);
    }
    const handlers = new Map<string, ToolHandler>();
    for (const binding of bindings) {
      if (!names.has(binding.name) || handlers.has(binding.name) || typeof binding.handler !== 'function') throw new Error('Invalid tool handler binding.');
      handlers.set(binding.name, binding.handler);
    }
    if (handlers.size !== names.size) throw new Error('Missing tool handler binding.');
    this.#catalog = freezeCopy(catalog);
    this.#handlers = handlers;
    this.catalogVersion = createHash('sha256').update(canonical(this.#catalog)).digest('hex');
  }

  capture(scope: ContextScope, profile: ToolProfile, policy: ToolPolicy): EffectiveToolSet {
    const trustedPolicy = policyCopy(policy);
    const availability = catalogAvailability(this.#catalog, profile, trustedPolicy);
    const admitted = new Set(availability.filter(item => item.available).map(item => item.name));
    const snapshot: EffectiveToolSet = freezeCopy({ schemaVersion: 1, scope: {
      scopeId: scope.scopeId, executionId: scope.executionId,
      ...(scope.conversationId !== undefined ? { conversationId: scope.conversationId } : {}),
      ...(scope.workId !== undefined ? { workId: scope.workId } : {}),
    }, profile, catalogVersion: this.catalogVersion, policy: trustedPolicy,
      registeredNames: this.#catalog.map(tool => tool.name),
      tools: this.#catalog.filter(tool => admitted.has(tool.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), availability });
    this.#captures.set(snapshot, admitted);
    return snapshot;
  }

  /** Each transport gets its own mutable copy, and cannot authorize a call. */
  project(snapshot: EffectiveToolSet): ToolDefinition[] {
    this.requireCapture(snapshot);
    return structuredClone(snapshot.tools) as ToolDefinition[];
  }

  async dispatch(snapshot: EffectiveToolSet, name: string, args: Record<string, unknown>, signal: AbortSignal, currentPolicy: ToolPolicy): Promise<unknown> {
    const admitted = this.requireCapture(snapshot);
    if (!admitted.has(name)) throw new RuntimeError('tool_denied', 'Tool is not available for this execution.', 403);
    const descriptor = this.#catalog.find(tool => tool.name === name);
    if (!descriptor) throw new RuntimeError('tool_denied', 'Tool is not available for this execution.', 403);
    const status = toolAvailability(descriptor, snapshot.profile, policyCopy(currentPolicy));
    if (!status.available) {
      if (status.reason === 'memory-disabled') throw new RuntimeError('memory_disabled', 'Memory is disabled.', 403);
      throw new RuntimeError('tool_denied', 'Tool is not available for this execution.', 403);
    }
    signal.throwIfAborted();
    const invocation: ToolInvocation = Object.freeze({ scope: snapshot.scope, executionId: snapshot.scope.executionId,
      kind: snapshot.profile === 'legacy-research' ? 'research' : snapshot.profile, profile: snapshot.profile, signal });
    return this.#handlers.get(name)!(args, invocation);
  }

  private requireCapture(snapshot: EffectiveToolSet): ReadonlySet<string> {
    const admitted = this.#captures.get(snapshot);
    if (!admitted) throw new RuntimeError('tool_denied', 'Invalid tool snapshot.', 403);
    return admitted;
  }
}
