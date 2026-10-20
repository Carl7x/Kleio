import type { ContextScope } from './context.ts';

export type ExecutionKind = 'conversation' | 'memory' | 'research' | 'review';
/** Mutable compatibility projection; it carries no execution authority. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export type ToolProfile = ExecutionKind | 'legacy-research';
export interface ToolPolicy {
  readonly memoryEnabled: boolean;
  readonly searchConfigured: boolean;
  /** undefined is unrestricted; [] admits nothing. Deny always wins. */
  readonly allowedTools?: readonly string[];
  readonly disabledTools?: readonly string[];
}
export type DeepReadonly<T> = T extends readonly (infer V)[] ? readonly DeepReadonly<V>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export interface ToolDescriptor extends DeepReadonly<ToolDefinition> {
  readonly profiles: readonly ToolProfile[];
  readonly requiresMemoryRecall: boolean;
  readonly capability: {
    readonly note: string;
    readonly configuration: 'always' | 'memory' | 'search';
  };
}
export interface ToolAvailability {
  readonly name: string;
  readonly available: boolean;
  readonly reason: 'available' | 'kind-denied' | 'policy-disabled' | 'memory-disabled';
  readonly capability: {
    readonly implemented: true;
    readonly configured: boolean;
    readonly configurationMode: 'always' | 'memory' | 'api-key' | 'keyless';
    readonly note: string;
  };
}
/** A structural representation for context consumers, never proof of authority. */
export interface EffectiveToolSet {
  readonly schemaVersion: 1;
  readonly scope: ContextScope;
  readonly profile: ToolProfile;
  readonly catalogVersion: string;
  readonly policy: ToolPolicy;
  readonly registeredNames: readonly string[];
  readonly tools: readonly DeepReadonly<ToolDefinition>[];
  readonly availability: readonly ToolAvailability[];
}
