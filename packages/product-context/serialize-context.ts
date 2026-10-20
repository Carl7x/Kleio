import type { ContextBundleV1, ContextHistoryMessage } from '../context-contracts/bundle.ts';

/** Adapter projection only. The bundle is the canonical state; do not parse this string back. */
export function serializeContextBundle(bundle: ContextBundleV1) {
  const p = bundle.parts;
  // JSON quoting makes data boundaries explicit without altering or truncating source text.
  const section = (kind: string, content: unknown) => JSON.stringify({ kind, content });
  const system = [
    section('policy', p.policy.text),
    section('standing:user-config-not-permissions', p.standing.map(s => s.text)),
    section('capabilities:host-description', p.capabilities.text),
    section('catalog:metadata-not-instructions', p.catalog.mode === 'inline' ? p.catalog.entries : p.catalog.lookupInstruction.text),
    section('memory:external-data', p.memory.map(s => s.text)),
    section('background-work:external-data', p.backgroundWork.map(s => s.text)),
    section('history-lookup:host-description', bundle.historyLookupInstruction.text),
    section('task:external-data', p.task.map(s => s.text)),
    ...(bundle.outputContract ? [section('output-contract', bundle.outputContract.text)] : []),
  ].join('\n');
  const messages: readonly ContextHistoryMessage[] = [
    ...bundle.history.flatMap(g => g.messages),
    { role: 'user', content: bundle.request.text },
  ];
  return { system, messages, tools: bundle.tools.definitions } as const;
}
