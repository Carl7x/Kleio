import type { EffectiveToolSet, ExecutionKind } from '../context-contracts/tools.ts';
import { PRODUCT_TOOL_CATALOG, catalogAvailability } from './tool-catalog.ts';
const UNAVAILABLE = ['computer', 'email', 'calendar', 'shell', 'browser', 'messaging'] as const;
export type ContextKind = ExecutionKind;
export interface CapabilityInput {
  kind: ContextKind;
  toolNames: readonly string[];
  searchConfigured: boolean;
  memoryEnabled: boolean;
  effectiveTools?: EffectiveToolSet;
}

/** Implemented, configured, and available this turn are separate facts. */
export function capabilityReport(input: CapabilityInput): string {
  const policy = input.effectiveTools?.policy ?? input;
  const facts = input.effectiveTools?.availability ?? catalogAvailability(PRODUCT_TOOL_CATALOG, input.kind, policy);
  const names = input.effectiveTools?.tools.map(tool => tool.name) ?? input.toolNames;
  const kind = input.effectiveTools?.profile === 'legacy-research' ? 'research' : input.effectiveTools?.profile ?? input.kind;
  const lines = [`Execution kind: ${kind}.`];
  for (const fact of facts) {
    const available = fact.available && names.includes(fact.name);
    let note = fact.capability.note;
    if (fact.capability.configurationMode === 'memory' && !policy.memoryEnabled) {
      note = 'Memory recall is disabled. Known-ID correction and forgetting stay available when memory_correct or memory_forget is available this turn. Do not skip those calls and do not report success without the tool result.';
    }
    if (fact.capability.configurationMode === 'api-key' || fact.capability.configurationMode === 'keyless') {
      const mode = fact.capability.configurationMode;
      note = `Configuration mode: ${mode}. ${available ? 'Callable this turn. Only the tool result shows whether this call succeeded. Cite only URLs it returned.' : 'Not callable this turn.'} Do not invent search results.`;
      lines.push(`- ${fact.name}: implemented=yes; configuration=${mode}; available=${available ? 'yes' : 'no'}. ${note}`);
    } else {
      lines.push(`- ${fact.name}: implemented=yes; configured=${fact.capability.configured ? 'yes' : 'no'}; available=${available ? 'yes' : 'no'}. ${note}`);
    }
  }
  lines.push(...UNAVAILABLE.map(name => `- ${name}: implemented=no; configured=no; available=no. Do not claim this capability.`));
  return lines.join('\n');
}
