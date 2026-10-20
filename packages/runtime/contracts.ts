import type { ContextBundleV1, ContextBudget, ContextManifestEntry } from '../context-contracts/bundle.ts';
import type { RequestAdmission } from './request-admission.ts';

import type { ExecutionKind, ToolDefinition } from '../context-contracts/tools.ts';
export type { ExecutionKind, ToolDefinition } from '../context-contracts/tools.ts';

/** Safe lifecycle metadata only; resource and standing bodies never belong in these events. */
export interface ContextPreparedEventData {
  version: 1; snapshotId: string; manifest: readonly ContextManifestEntry[]; budget: ContextBudget;
  diagnostics: readonly { code: string; skillId?: string }[];
}
export interface ContextResourceEventData {
  tool: string; kind?: string; sourceRef?: string; sourceVersion?: string; pageIndex?: number; bytes?: number; code?: string;
}

export interface ExecutionInput {
  bundle?: ContextBundleV1;
  id: string;
  kind: ExecutionKind;
  prompt: string;
  context: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: ToolDefinition[];
}

export interface ExecutionContext {
  signal: AbortSignal;
  onText(text: string): void;
  onEvent(event: { type: string; data?: Record<string, unknown> }): void;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Absent keeps the legacy engine profile. A present but incomplete port must fail closed. */
  requestAdmission?: RequestAdmission;
}

export interface Engine {
  readonly id: string;
  readonly contextCapabilities?: { readonly bundle: 1; readonly admission: 1; readonly receipts: 1 };
  execute(input: ExecutionInput, context: ExecutionContext): Promise<{ text: string; engineSessionId?: string }>;
  close(): Promise<void>;
}

export class RuntimeError extends Error {
  readonly retryable?: boolean;
  readonly requestSequence?: number;
  readonly estimatedInputTokens?: number;
  constructor(readonly code: string, message: string, readonly status = 400, detail?: { readonly retryable?: boolean; readonly requestSequence?: number; readonly estimatedInputTokens?: number }) {
    super(message); this.name = 'RuntimeError';
    if (detail?.retryable !== undefined) this.retryable = detail.retryable;
    if (detail?.requestSequence !== undefined) this.requestSequence = detail.requestSequence;
    if (detail?.estimatedInputTokens !== undefined) this.estimatedInputTokens = detail.estimatedInputTokens;
  }
}
