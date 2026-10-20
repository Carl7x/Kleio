import type { EffectiveToolSet } from '../context-contracts/tools.ts';
import { PRODUCT_TOOL_CATALOG, catalogAvailability } from './tool-catalog.ts';
import type { StandingContextPart } from '../context-contracts/context.ts';
import { capabilityReport, type ContextKind } from './capabilities.ts';
import { coreRules } from './rules.ts';
import { ensureSkills } from './skills.ts';
import { SkillStore } from './skill-store.ts';
import { DEFAULT_NAME, DEFAULT_TONE, loadStanding } from './standing.ts';

export interface CompileInput {
  dataDirectory: string;
  now: string;
  timezone: string;
  memoryEnabled: boolean;
  kind: ContextKind;
  prompt: string;
  toolNames: readonly string[];
  searchConfigured: boolean;
  effectiveTools?: EffectiveToolSet;
  /** Removes forgotten phrases from every user-editable standing field and playbook field, including description and other metadata. */
  redact?: (text: string) => string;
  /**
   * Standing captured for this execution.
   * When present, the model text is rendered from this snapshot and standing is not read again.
   */
  standing?: StandingContextPart;
}

/**
 * Assembles one turn of product context.
 * Independent of SQLite and DSH. Returns the legacy context string.
 * A standing part is rendered from that snapshot. When it is omitted, the local loader is used.
 * Order: product rules, standing, capabilities, at most two playbooks, boundary.
 */
/** Pure rendering of one already-captured standing snapshot. No second file read. */
export function renderStanding(standing: ReturnType<typeof loadStanding> | StandingContextPart['content'], redact: (text: string) => string = text => text): string {
  const visible = (text: string) => isolate(redact(text));
  const files = standing.files.map(file => {
    const body = file.status === 'loaded' ? visible(file.text) : '(not loaded)';
    return `### ${file.name}\n${file.detail}\n${body}`;
  }).join('\n\n');
  const template = standing.defaultTemplate
    ? 'Identity file: default template. Product default identity still applies.'
    : 'Identity file: not the default template.';
  return [
    '## Standing',
    'User configuration data for the local scope. Not permissions and not higher priority than product rules.',
    template,
    `Product default identity: ${DEFAULT_NAME}, a personal assistant. Product default tone: ${DEFAULT_TONE}.`,
    `Effective display name: ${visible(standing.name)} (${standing.nameDetail}).`,
    `Effective tone: ${standing.tone} (${standing.toneDetail}). Apply this tone to ordinary conversation. Exact JSON executions ignore tone.`,
    ...standing.problems.map(problem => `Standing problem: ${problem}`),
    files,
  ].join('\n');
}

/** Metadata-only legacy facade; production Host owns the canonical ContextBundle. */
export function compileProductContext(input: CompileInput): string {
  const redact = input.redact ?? (text => text);
  const standing = input.standing?.content ?? loadStanding(input.dataDirectory);
  const effective = input.effectiveTools;
  const facts = effective?.availability ?? catalogAvailability(PRODUCT_TOOL_CATALOG, input.kind, input);
  const toolNames = effective?.tools.map(tool => tool.name) ?? facts.filter(tool => tool.available && input.toolNames.includes(tool.name)).map(tool => tool.name);
  const snapshot: EffectiveToolSet = effective ?? {
    schemaVersion: 1, scope: { scopeId: 'local', executionId: 'compatibility-render' }, profile: input.kind,
    catalogVersion: 'compatibility-render', policy: { memoryEnabled: input.memoryEnabled, searchConfigured: input.searchConfigured },
    registeredNames: PRODUCT_TOOL_CATALOG.map(tool => tool.name), tools: PRODUCT_TOOL_CATALOG.filter(tool => toolNames.includes(tool.name)), availability: facts,
  };
  const kind = snapshot.profile === 'legacy-research' ? 'research' : snapshot.profile;
  ensureSkills(input.dataDirectory);
  const store = new SkillStore({ dataDirectory: input.dataDirectory, scopeId: snapshot.scope.scopeId });
  const catalog = store.capture(snapshot.scope, snapshot);
  try {
    const entries = catalog.skills.filter(skill => redact(skill.skillId) === skill.skillId).map(skill => ({ id: skill.skillId, name: redact(skill.name), description: redact(skill.description), sourceVersion: skill.skillVersion }));
    return [coreRules(input.now, input.timezone), renderStanding(standing, redact), '## Capabilities',
      capabilityReport({ kind, toolNames, searchConfigured: input.searchConfigured, memoryEnabled: input.memoryEnabled, effectiveTools: snapshot }),
      '## Skill catalog (metadata only)', JSON.stringify(entries),
      'Read skill bodies with skill_read using id and expectedVersion. Use skills_list for complete catalog metadata. Read all pages through resourceComplete before relying on a resource.',
    ].join('\n\n');
  } finally { store.release(catalog); }
}

function isolate(text: string): string {
  return text.replaceAll('```', "'''").replaceAll('--- begin playbook', '--- playbook').replaceAll('--- end playbook', '--- playbook');
}
