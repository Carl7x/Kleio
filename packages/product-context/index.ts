/** Local product configuration: standing, rules, capabilities, and playbooks. No SQLite and no DSH. */
export { capabilityReport } from './capabilities.ts';
export type { ContextKind } from './capabilities.ts';
export { compileProductContext, renderStanding } from './compile.ts';
export { openFollowsSymlinks, scopeRoot } from './files.ts';
export { coreRules } from './rules.ts';
export { ensureSkills, KNOWN_TOOLS, parseSkillMarkdown, selectSkills, SKILL_ID, SKILL_LIMIT } from './skills.ts';
export {
  DEFAULT_NAME, DEFAULT_TONE, ensureStanding, ioDetail, loadStanding, parseIdentity, STANDING_LIMIT, STANDING_TEMPLATES,
  STANDING_UNAVAILABLE, StandingStore, StandingStoreError,
  TONES, validateName, validateTone, writeIdentityFields,
} from './standing.ts';
export type { Tone } from './standing.ts';

export { compileContextBundle } from './context-bundle.ts';
export { serializeContextBundle } from './serialize-context.ts';
