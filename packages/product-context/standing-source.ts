import {
  CONFIG_CHANGED,
  CONTEXT_SCOPE_MISMATCH,
  STANDING_NAMES as STANDING_FILES,
  STANDING_TONES as TONES,
  type StandingName,
  type StandingTone as Tone,
} from '../context-contracts/context.ts';
import { createBoundedIfAbsent, readBounded, scopeRoot, writeBounded, type IoReason } from './files.ts';

export { STANDING_FILES, TONES };
export type { StandingName, Tone };

export const STANDING_UNAVAILABLE = 'STANDING_UNAVAILABLE' as const;

export type StandingStoreErrorCode =
  | typeof CONTEXT_SCOPE_MISMATCH
  | typeof CONFIG_CHANGED
  | typeof STANDING_UNAVAILABLE;

const MESSAGES: Record<StandingStoreErrorCode, string> = {
  CONTEXT_SCOPE_MISMATCH: 'CONTEXT_SCOPE_MISMATCH: Standing scope does not match this store.',
  CONFIG_CHANGED: 'CONFIG_CHANGED: Standing files changed while they were being read. Stop editing and retry.',
  STANDING_UNAVAILABLE: 'STANDING_UNAVAILABLE: Standing data is unavailable.',
};

/** Fixed codes only. The message never includes a path, a file body, or a raw exception. */
export class StandingStoreError extends Error {
  readonly code: StandingStoreErrorCode;
  constructor(code: StandingStoreErrorCode) {
    super(MESSAGES[code]);
    this.name = 'StandingStoreError';
    this.code = code;
  }
}

export const STANDING_LIMIT = 16 * 1024;
export const DEFAULT_NAME = 'Kleio';
export const DEFAULT_TONE: Tone = 'warm';

const NAME_LINE = /^-\s*Name:\s*(.*)$/m;
const TONE_LINE = /^-\s*Tone:\s*(.*)$/m;

export const STANDING_TEMPLATES: Record<StandingName, string> = {
  'IDENTITY.md': `# Identity

Kleio reads this file at the start of every turn. Fill in a display name and tone if you want them. Blank or invalid fields use the product default. This file does not grant tools and does not override product rules.

- Name: Kleio
- Tone: warm

## Notes

Optional notes about how you want to be addressed. Preference text only.
`,
  'SOUL.md': `# Soul

How you want Kleio to behave, in your own words. Leave the notes empty to keep the product default. These notes do not grant tools or override product rules.

## Notes
`,
  'USER.md': `# User

Stable notes about how to address you. Dated facts belong in memory, where they can be corrected or forgotten. Do not put secrets or credentials here.

## Notes
`,
  'TOOLS.md': `# Tools

Local names for things you care about. This file cannot enable shell, email, calendar, Computer, or any tool the product did not list for this turn.

## Notes
`,
  'AGENTS.md': `# Agents

Working agreements you want kept. This file does not create agents, connectors, or permissions.

## Notes
`,
};

const DETAILS: Record<string, string> = {
  missing: 'missing. The product default is used.',
  symlink: 'a symlink and was not followed.',
  'not-file': 'not a regular file.',
  'too-large': 'over the size limit and was not loaded.',
  escape: 'resolves outside the data directory and was not loaded.',
  path: 'not an allowed product path.',
  unreadable: 'unreadable.',
  blank: 'blank. The product default is used.',
  'invalid-fields': 'name or tone is empty or not allowed.',
  'invalid-encoding': 'not valid UTF-8 and was not loaded.',
};

export function ioDetail(reason: string): string {
  return DETAILS[reason] ?? 'unavailable.';
}

export function standingSegments(name: StandingName): readonly ['standing', StandingName] {
  return ['standing', name];
}

/** Resolve a trusted data root. Any failure is a fixed code and does not include the path. */
export function openDataRoot(dataDirectory: string): string {
  try {
    if (typeof dataDirectory !== 'string' || dataDirectory.length === 0) throw new StandingStoreError('STANDING_UNAVAILABLE');
    return scopeRoot(dataDirectory);
  } catch (error) {
    if (error instanceof StandingStoreError) throw error;
    throw new StandingStoreError('STANDING_UNAVAILABLE');
  }
}

export function validateName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || name.includes('```')) return null;
  return name;
}

export function validateTone(value: string): Tone | null {
  return TONES.find(tone => tone === value.trim()) ?? null;
}

/**
 * Create each missing template once. An existing file, symlink, or other entry is left in place.
 * created lists only entries this call actually created.
 */
export function ensureStandingFiles(root: string): { created: StandingName[]; problems: string[] } {
  const created: StandingName[] = [];
  const problems: string[] = [];
  for (const name of STANDING_FILES) {
    const result = createBoundedIfAbsent(root, standingSegments(name), STANDING_TEMPLATES[name], STANDING_LIMIT);
    if (!result.ok) {
      problems.push(`${name} is ${ioDetail(result.reason)}`);
      continue;
    }
    if (result.created) created.push(name);
  }
  return { created, problems };
}

export function ensureStanding(dataDirectory: string): { created: StandingName[]; problems: string[] } {
  return ensureStandingFiles(openDataRoot(dataDirectory));
}

function unix(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export function parseIdentity(text: string): { name: string | null; tone: Tone | null; nameProblem: string; toneProblem: string } {
  const nameMatch = NAME_LINE.exec(unix(text));
  const toneMatch = TONE_LINE.exec(unix(text));
  const name = nameMatch ? validateName(nameMatch[1] ?? '') : null;
  const tone = toneMatch ? validateTone(toneMatch[1] ?? '') : null;
  return {
    name, tone,
    nameProblem: !nameMatch ? 'IDENTITY.md has no Name field.' : name ? '' : 'IDENTITY.md name is blank or invalid.',
    toneProblem: !toneMatch ? 'IDENTITY.md has no Tone field.' : tone ? '' : 'IDENTITY.md tone is not warm, concise, or thoughtful.',
  };
}

export function writeIdentityFields(dataDirectory: string, fields: { name: string; tone: string }): { ok: true } | { ok: false; reason: IoReason } {
  const name = validateName(fields.name);
  const tone = validateTone(fields.tone);
  if (!name || !tone) return { ok: false, reason: 'invalid-fields' };
  ensureStanding(dataDirectory);
  const root = openDataRoot(dataDirectory);
  const current = readBounded(root, standingSegments('IDENTITY.md'), STANDING_LIMIT);
  if (!current.ok) return { ok: false, reason: current.reason };
  const base = current.text.trim() ? unix(current.text) : STANDING_TEMPLATES['IDENTITY.md'];
  return writeBounded(root, standingSegments('IDENTITY.md'), applyIdentityFields(base, name, tone), STANDING_LIMIT);
}

function applyIdentityFields(text: string, name: string, tone: Tone): string {
  let next = text.endsWith('\n') ? text : `${text}\n`;
  if (NAME_LINE.test(next)) next = next.replace(NAME_LINE, () => `- Name: ${name}`);
  else next = `- Name: ${name}\n${next}`;
  if (TONE_LINE.test(next)) next = next.replace(TONE_LINE, () => `- Tone: ${tone}`);
  else next = next.replace(NAME_LINE, line => `${line}\n- Tone: ${tone}`);
  return next;
}
