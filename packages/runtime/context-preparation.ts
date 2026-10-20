import { randomUUID, createHash } from 'node:crypto';
import type { ContextScope, StandingContextPart } from '../context-contracts/context.ts';
import type { ContextHistoryGroup, ContextTextSource } from '../context-contracts/bundle.ts';
import type { EffectiveToolSet } from '../context-contracts/tools.ts';
import { compileContextBundle } from '../product-context/context-bundle.ts';
import { serializeContextBundle } from '../product-context/serialize-context.ts';
import { coreRules } from '../product-context/rules.ts';
import { renderStanding } from '../product-context/compile.ts';
import { capabilityReport } from '../product-context/capabilities.ts';
import { SkillStore } from '../product-context/skill-store.ts';
import { ensureSkills } from '../product-context/skills.ts';
import { ExecutionResources } from './execution-resources.ts';
import { createRequestAdmission } from './request-admission.ts';
import { RuntimeError, type Engine, type ExecutionInput } from './contracts.ts';

export interface ExecutionDraft {
  readonly prompt: string;
  /** Trusted recall query override; never injected as a second history body. */
  readonly memoryQuery?: string;
  readonly outputContract: string;
  readonly history: readonly ContextHistoryGroup[];
  readonly task?: readonly ContextTextSource[];
}
export function contextSource(sourceRef: string, text: string): ContextTextSource {
  return { sourceRef, text, sourceVersion: createHash('sha256').update(text).digest('hex') };
}
export function assertControlledContext(engine: Engine, capacity: { contextWindow?: number; maxTokens?: number }) {
  if (!Number.isSafeInteger(capacity.contextWindow) || !Number.isSafeInteger(capacity.maxTokens) || capacity.contextWindow! <= 0 || capacity.maxTokens! <= 0 || capacity.maxTokens! >= capacity.contextWindow!) {
    throw new RuntimeError('CONTEXT_CONFIGURATION_ERROR', 'Configure explicit positive model contextWindow and maxTokens before executing a model request.', 409);
  }
  const c = engine.contextCapabilities;
  if (c?.bundle !== 1 || c.admission !== 1 || c.receipts !== 1) throw new RuntimeError('ENGINE_CONTEXT_UNSUPPORTED', 'The engine must support context bundle v1, request admission v1 and retained resource receipts v1.', 409);
  return { contextWindow: capacity.contextWindow!, maxTokens: capacity.maxTokens! };
}

/** Host facts go in; canonical bundle and an execution-owned resource session come out. */
export function prepareExecutionContext(input: {
  scope: ContextScope; effectiveTools: EffectiveToolSet; draft: ExecutionDraft;
  capacity: { contextWindow: number; maxTokens: number }; standing?: StandingContextPart;
  memory: readonly ContextTextSource[]; backgroundWork: readonly ContextTextSource[];
  dataDirectory: string; now: string; timezone: string; redact: (text: string) => string;
  hostGeneration: number; policyEpoch: number; readPolicyEpoch: () => number;
}) {
  const kind = input.effectiveTools.profile === 'legacy-research' ? 'research' : input.effectiveTools.profile;
  const resourcesEnabled = kind !== 'memory' && kind !== 'review';
  let resources: ExecutionResources | undefined;
  try {
    if (resourcesEnabled) {
      ensureSkills(input.dataDirectory);
      resources = new ExecutionResources({ scope: input.scope, effectiveTools: input.effectiveTools,
        skillStore: new SkillStore({ dataDirectory: input.dataDirectory, scopeId: input.scope.scopeId }), redact: input.redact,
        standing: input.standing?.content.files.map(file => ({ name: file.name, text: file.text, sourceVersion: file.sourceVersion })) ?? [], history: input.draft.history });
    }
    const result = compileContextBundle({ executionId: input.scope.executionId, scopeRef: input.scope.scopeId,
      snapshotId: randomUUID(), policyVersion: `context-v1:${input.hostGeneration}:${input.policyEpoch}`, capacity: input.capacity,
      policy: contextSource('product-policy', kind === 'memory' ? input.draft.outputContract : coreRules(input.now, input.timezone)),
      standing: input.standing ? [contextSource('standing:effective', renderStanding(input.standing.content, input.redact))] : [],
      capabilities: contextSource('capabilities', kind === 'memory' ? 'Memory extraction has no tools or independent actions.' : capabilityReport({ kind,
        toolNames: input.effectiveTools.tools.map(tool => tool.name), effectiveTools: input.effectiveTools, ...input.effectiveTools.policy })),
      catalog: { entries: resources?.catalog.entries ?? [], lookupInstruction: contextSource('skill-catalog', resourcesEnabled ? 'Use skills_list for complete skill metadata, then skill_read with skillId and expectedVersion for needed bodies. Follow all pages to resourceComplete.' : '') },
      memory: kind === 'memory' ? [] : input.memory, history: input.draft.history,
      historyLookupInstruction: { ...contextSource('history-index', resourcesEnabled ? 'Use context_read with sourceRef history-index to find all complete history groups, including budget-omitted groups; then read their sourceRef to resourceComplete.' : ''), sourceRef: 'history-index' },
      backgroundWork: kind === 'memory' ? [] : input.backgroundWork, task: input.draft.task ?? [], request: contextSource('current-request', input.draft.prompt),
      tools: { sourceRef: 'registered-tools', sourceVersion: input.effectiveTools.catalogVersion, definitions: input.effectiveTools.tools },
      outputContract: contextSource('output-contract', input.draft.outputContract),
    });
    if (!result.ok) throw new RuntimeError(result.code, result.code === 'CONTEXT_BUDGET_EXCEEDED' ? 'Required context does not fit this execution budget. Reduce required input or configure sufficient capacity.' : 'The configured model capacity cannot support this execution.', 409);
    const bundle = result.bundle;
    if (resources) { resources.setHistorySelection(bundle.manifest); resources.initializeBudget(bundle.budget); }
    const requestAdmission = createRequestAdmission({ executionId: input.scope.executionId, scopeId: input.scope.scopeId,
      hostGeneration: input.hostGeneration, policyEpoch: input.policyEpoch, readPolicyEpoch: input.readPolicyEpoch,
      profile: { version: 'context-v1', contextLimit: input.capacity.contextWindow, outputLimit: input.capacity.maxTokens, safetyMarginTokens: bundle.budget.safetyTokens },
      ...(resources ? { resourceLedger: resources.ledger } : {}) });
    const projection = serializeContextBundle(bundle);
    const engineInput: ExecutionInput = { id: input.scope.executionId, kind, prompt: bundle.request.text, context: [bundle.parts.policy.text, ...bundle.parts.standing.map(source => source.text), bundle.parts.capabilities.text,
        bundle.parts.catalog.mode === 'inline' ? JSON.stringify(bundle.parts.catalog.entries) : bundle.parts.catalog.lookupInstruction.text,
        ...bundle.parts.memory.map(source => source.text), ...bundle.parts.backgroundWork.map(source => source.text), bundle.historyLookupInstruction.text,
        ...bundle.parts.task.map(source => source.text), bundle.outputContract?.text ?? ''].join('\n\n'),
      history: projection.messages.slice(0, -1).filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ role: message.role as 'user' | 'assistant', content: message.content })),
      tools: structuredClone(projection.tools) as ExecutionInput['tools'], bundle };
    return { input: engineInput, resources, requestAdmission, diagnostics: (resources?.catalog.diagnostics ?? []).flatMap(value => {
      if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string') return [];
      return [{ code: value.code, ...('skillId' in value && typeof value.skillId === 'string' ? { skillId: value.skillId } : {}) }];
    }) };
  } catch (error) { resources?.close(); throw error; }
}
