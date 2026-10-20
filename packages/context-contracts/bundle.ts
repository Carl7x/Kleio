/** Pure context data, not authority or an engine protocol. Versions are supplied by trusted collectors. */
import type { DeepReadonly, ToolDefinition } from './tools.ts';
export type BundlePartKind = 'policy' | 'standing' | 'capabilities' | 'catalog' | 'memory' | 'history' | 'task' | 'background-work' | 'request' | 'tools';
export interface ContextTextSource {
  readonly sourceRef: string;
  /** Content identity/hash supplied by the owner, never inferred from a display label. */
  readonly sourceVersion: string;
  readonly text: string;
}
export interface CatalogMetadata {
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
export interface ContextHistoryMessage { readonly role: 'user' | 'assistant' | 'tool'; readonly content: string; readonly toolCallId?: string; readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[] }
/** A complete turn/call-output group; selection never splits its messages. */
export interface ContextHistoryGroup {
  readonly sourceRef: string;
  readonly sourceVersion: string;
  /** Trusted collector's budget retention requirement; never grants authority. */
  readonly required?: true;
  readonly messages: readonly ContextHistoryMessage[];
}
export interface ContextManifestEntry {
  readonly kind: BundlePartKind;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly authority: 'product-policy' | 'user-config' | 'host-description' | 'external-data' | 'current-request' | 'tool-schema';
  readonly required: boolean;
  readonly estimatedTokens: number;
  readonly included: boolean;
  readonly reason: 'required' | 'selected' | 'budget-omitted' | 'catalog-lookup-fallback';
}
export interface ContextBudget {
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly safetyTokens: number;
  readonly inputBudget: number;
  readonly dynamicReserve: number;
  readonly initialLimit: number;
  readonly estimatedInputTokens: number;
  readonly estimatorId: 'utf8-bytes-plus-framing-v1';
}
export interface ContextBundleInput {
  readonly executionId: string;
  readonly scopeRef: string;
  readonly snapshotId: string;
  readonly policyVersion: string;
  readonly capacity: { readonly contextWindow: number; readonly maxTokens: number };
  readonly policy: ContextTextSource;
  readonly standing: readonly ContextTextSource[];
  readonly capabilities: ContextTextSource;
  readonly catalog: { readonly entries: readonly CatalogMetadata[]; readonly lookupInstruction: ContextTextSource };
  /** Priority order, highest first. All external text remains data. */
  readonly memory: readonly ContextTextSource[];
  /** Chronological oldest to newest; compiler prioritizes newest whole groups. */
  readonly history: readonly ContextHistoryGroup[];
  /** Host MUST register a pageable context_read resource at this sourceRef from
   * the omitted history manifest and retain its original groups for later reads.
   * This small instruction is always model-visible and budgeted. */
  readonly historyLookupInstruction: ContextTextSource & { readonly sourceRef: 'history-index' };
  readonly backgroundWork?: readonly ContextTextSource[];
  readonly task: readonly ContextTextSource[];
  readonly request: ContextTextSource;
  readonly tools: { readonly sourceRef: string; readonly sourceVersion: string; readonly definitions: readonly DeepReadonly<ToolDefinition>[] };
  readonly outputContract?: ContextTextSource;
}
export interface ContextBundleV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly scopeRef: string;
  readonly snapshotId: string;
  readonly policyVersion: string;
  readonly parts: {
    readonly policy: ContextTextSource;
    readonly standing: readonly ContextTextSource[];
    readonly capabilities: ContextTextSource;
    readonly catalog: { readonly mode: 'inline' | 'lookup'; readonly entries: readonly CatalogMetadata[]; readonly lookupInstruction: ContextTextSource };
    readonly memory: readonly ContextTextSource[];
    readonly task: readonly ContextTextSource[];
    readonly backgroundWork: readonly ContextTextSource[];
  };
  readonly request: ContextTextSource;
  readonly history: readonly ContextHistoryGroup[];
  readonly historyLookupInstruction: ContextTextSource & { readonly sourceRef: 'history-index' };
  readonly tools: ContextBundleInput['tools'];
  readonly outputContract?: ContextTextSource;
  readonly manifest: readonly ContextManifestEntry[];
  readonly budget: ContextBudget;
}
export type CompileContextBundleResult = { readonly ok: true; readonly bundle: ContextBundleV1 } | {
  readonly ok: false;
  readonly code: 'CONTEXT_CONFIGURATION_ERROR' | 'CONTEXT_BUDGET_EXCEEDED';
  readonly reason: 'invalid-capacity' | 'nonpositive-input-budget' | 'required-content-too-large';
  readonly budget?: ContextBudget;
  readonly manifest: readonly ContextManifestEntry[];
};
