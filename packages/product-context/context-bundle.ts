import type { BundlePartKind, CompileContextBundleResult, ContextBudget, ContextBundleInput, ContextBundleV1, ContextManifestEntry } from '../context-contracts/bundle.ts';
import { serializeContextBundle } from './serialize-context.ts';

/** Deliberately conservative heuristic: one token per UTF-8 byte plus 32 per
 * message/schema and 64 request framing tokens. Not a provider tokenizer. The
 * actual envelope admission gate must still run before every model request. */
export const CONTEXT_ESTIMATOR_ID = 'utf8-bytes-plus-framing-v1' as const;
export function estimateContextValue(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length + 32;
}
export function estimateBundleProjection(bundle: ContextBundleV1): number {
  const projection = serializeContextBundle(bundle);
  return 64 + estimateContextValue(projection.system) + projection.messages.reduce((n, m) => n + estimateContextValue(m), 0)
    + projection.tools.reduce((n, t) => n + estimateContextValue(t), 0);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Pure deterministic selection. Collectors own policy, forgetting, ordering and versions. */
export function compileContextBundle(input: ContextBundleInput): CompileContextBundleResult {
  const c = input.capacity?.contextWindow, r = input.capacity?.maxTokens;
  if (!Number.isSafeInteger(c) || !Number.isSafeInteger(r) || c <= 0 || r <= 0) {
    return freeze({ ok: false, code: 'CONTEXT_CONFIGURATION_ERROR', reason: 'invalid-capacity', manifest: [] });
  }
  const safetyTokens = Math.max(2048, Math.ceil(.1 * c));
  const inputBudget = c - r - safetyTokens;
  const dynamicReserve = Math.max(0, Math.floor(.25 * inputBudget));
  const baseBudget: ContextBudget = { contextWindow: c, maxTokens: r, safetyTokens, inputBudget, dynamicReserve, initialLimit: inputBudget - dynamicReserve, estimatedInputTokens: 0, estimatorId: CONTEXT_ESTIMATOR_ID };
  if (inputBudget <= 0) return freeze({ ok: false, code: 'CONTEXT_CONFIGURATION_ERROR', reason: 'nonpositive-input-budget', budget: baseBudget, manifest: [] });
  // Clone before freezing: publication must never freeze the caller's owned inputs.
  const i = structuredClone(input);
  // Whitelist metadata fields: structural typing must not accidentally publish a
  // collector's private package body or filesystem locator as catalog metadata.
  const catalogEntries = i.catalog.entries.map(e => ({ sourceRef: e.sourceRef, sourceVersion: e.sourceVersion, id: e.id, name: e.name, description: e.description }));
  const manifest: ContextManifestEntry[] = [];
  const add = (kind: BundlePartKind, source: { sourceRef: string; sourceVersion: string }, required: boolean, authority: ContextManifestEntry['authority'], estimatedTokens: number, included: boolean, reason: ContextManifestEntry['reason']) => {
    manifest.push({ kind, sourceRef: source.sourceRef, sourceVersion: source.sourceVersion, required, authority, estimatedTokens, included, reason });
  };
  const bundle: ContextBundleV1 = {
    version: 1, executionId: i.executionId, scopeRef: i.scopeRef, snapshotId: i.snapshotId, policyVersion: i.policyVersion,
    parts: { policy: i.policy, standing: i.standing, capabilities: i.capabilities,
      catalog: { mode: 'lookup', entries: [], lookupInstruction: i.catalog.lookupInstruction }, memory: [], task: i.task, backgroundWork: [] },
    request: i.request, history: i.history.filter(group => group.required === true), historyLookupInstruction: i.historyLookupInstruction, tools: i.tools, ...(i.outputContract ? { outputContract: i.outputContract } : {}), manifest, budget: baseBudget,
  };
  add('history', i.historyLookupInstruction, true, 'host-description', estimateContextValue(i.historyLookupInstruction.text), true, 'required');
  add('policy', i.policy, true, 'product-policy', estimateContextValue(i.policy.text), true, 'required');
  for (const s of i.standing) add('standing', s, true, 'user-config', estimateContextValue(s.text), true, 'required');
  add('capabilities', i.capabilities, true, 'host-description', estimateContextValue(i.capabilities.text), true, 'required');
  for (const s of i.task) add('task', s, true, 'external-data', estimateContextValue(s.text), true, 'required');
  if (i.outputContract) add('policy', i.outputContract, true, 'product-policy', estimateContextValue(i.outputContract.text), true, 'required');
  add('request', i.request, true, 'current-request', estimateContextValue({ role: 'user', content: i.request.text }), true, 'required');
  add('tools', i.tools, true, 'tool-schema', i.tools.definitions.reduce((n, t) => n + estimateContextValue(t), 0), true, 'required');
  for (const group of bundle.history) add('history', group, true, 'external-data', estimateContextValue(group.messages), true, 'required');
  const mandatoryCost = estimateBundleProjection(bundle);
  if (mandatoryCost > baseBudget.initialLimit) {
    return freeze({ ok: false, code: 'CONTEXT_BUDGET_EXCEEDED', reason: 'required-content-too-large', budget: { ...baseBudget, estimatedInputTokens: mandatoryCost }, manifest });
  }
  let selected = bundle;
  const inline = { ...selected, parts: { ...selected.parts, catalog: { ...selected.parts.catalog, mode: 'inline' as const, entries: catalogEntries } } };
  const catalogCost = estimateContextValue(JSON.stringify({ kind: 'catalog:metadata-not-instructions', content: catalogEntries }));
  const useInline = catalogCost <= Math.min(2048, Math.floor(.1 * inputBudget)) && estimateBundleProjection(inline) <= baseBudget.initialLimit;
  if (useInline) selected = inline;
  add('catalog', i.catalog.lookupInstruction, !useInline, 'host-description', estimateContextValue(i.catalog.lookupInstruction.text), !useInline, useInline ? 'selected' : 'catalog-lookup-fallback');
  for (const e of catalogEntries) add('catalog', e, false, 'external-data', estimateContextValue(e), useInline, useInline ? 'selected' : 'catalog-lookup-fallback');
  for (const source of i.memory) {
    const candidate = { ...selected, parts: { ...selected.parts, memory: [...selected.parts.memory, source] } };
    const fits = estimateBundleProjection(candidate) <= baseBudget.initialLimit;
    add('memory', source, false, 'external-data', estimateContextValue(source.text), fits, fits ? 'selected' : 'budget-omitted');
    if (fits) selected = candidate;
  }
  for (const source of i.backgroundWork ?? []) {
    const candidate = { ...selected, parts: { ...selected.parts, backgroundWork: [...selected.parts.backgroundWork, source] } };
    const fits = estimateBundleProjection(candidate) <= baseBudget.initialLimit;
    add('background-work', source, false, 'external-data', estimateContextValue(source.text), fits, fits ? 'selected' : 'budget-omitted');
    if (fits) selected = candidate;
  }
  const selectedGroups = new Set(selected.history);
  for (const group of [...i.history].reverse()) {
    if (group.required === true) continue;
    // Required groups may be interleaved with optional groups. Preserve the
    // collector's chronological order without adding required groups twice.
    const candidate = { ...selected, history: i.history.filter(item => item === group || selectedGroups.has(item)) };
    const fits = estimateBundleProjection(candidate) <= baseBudget.initialLimit;
    add('history', group, false, 'external-data', estimateContextValue(group.messages), fits, fits ? 'selected' : 'budget-omitted');
    if (fits) { selected = candidate; selectedGroups.add(group); }
  }
  return freeze({ ok: true, bundle: { ...selected, budget: { ...baseBudget, estimatedInputTokens: estimateBundleProjection(selected) } } });
}
