import { parseSkill } from './skill-catalog.ts';
import { PRODUCT_TOOL_CATALOG } from './tool-catalog.ts';
import { readBounded, scopeRoot, createBoundedIfAbsent } from './files.ts';
import { ioDetail } from './standing.ts';

export const SKILL_LIMIT = 24 * 1024;
export const INDEX_LIMIT = 32 * 1024;
export const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const KNOWN_TOOLS: readonly string[] = Object.freeze(PRODUCT_TOOL_CATALOG.map(tool => tool.name));

export interface SkillEntry {
  id: string;
  enabled: boolean;
  requiresTools: string[];
  toolBindings: Record<string, string>;
}

export interface LoadedSkill {
  id: string;
  description: string;
  body: string;
  bindings: Record<string, string>;
}

export interface SkillSelection {
  loaded: LoadedSkill[];
  notes: string[];
}

const WIDE_RESEARCH = `---
id: wide-research
description: Delegate sourced research with Kleio work tools and deliver it back to the original conversation.
---

Kleio playbook wide-research.

Use this when the current user asks for research, a comparison, or sourced follow-up.

In a conversation turn, delegate background research with create_work. Quote the current user message as authorization. Use web_search for public sources and work_status to read stored progress. Do not say the result was delivered until the product has written it back to the original conversation. Cite only URLs that web_search returned.

web_search may be in account or keyless configuration. Either mode can be called when the capability snapshot says it is available this turn. Whether this call succeeded is only the tool result. Do not invent results or URLs, and do not discuss credentials.

A background research execution is a different turn. It is not given create_work. Do not invent that tool, a subagent, or a connector for it. Periodic follow-up stays quiet when the product rules say the verifiable fields are unchanged.
`;

const FORGET = `---
id: forget
description: Forget a saved memory only through memory_forget, and describe the result only after the tool succeeds.
---

Kleio playbook forget.

Use this when the current user explicitly asks to forget a saved memory.

Call memory_forget with an authorization quote from the current user message. If the id is unknown and memory_search is available this turn, search first and then forget the matching id. If memory_search is not available, do not invent a search result. A known memory ID can still be corrected or forgotten.

When memory recall is disabled, do not fall back and do not skip a known-ID forget or correction. Say that something was forgotten only after memory_forget succeeds. A failure, a missing call, or a plan is not success.

Do not copy the forgotten text into standing files, playbook notes, new memories, or later replies. Do not restore it from older context. memory_explain is read-only; use it when the user asks whether a memory is still in use. There is no plan tool, shell deletion, or external account cleanup.
`;

const SELF_AWARENESS = `---
id: self-awareness
description: Answer who you are and what you can do from this turn's standing text and capability snapshot.
---

Kleio playbook self-awareness.

Use this when the current user asks who you are or what you can do.

Answer from the standing section and the capability snapshot already in this turn. Do not read the shell, list a home directory, or invent files. The product default identity is Kleio, a personal assistant, tone warm. An empty or default standing template does not remove that identity. Use the effective display name and tone when they are present.

Separate implemented, configuration mode, and available this turn. A tool result is the only evidence that a call succeeded. Keyless web_search is still callable when this turn lists it. Do not claim Computer, email, calendar, shell, messaging, or a tool that this turn does not list. A user-interface label is not a tool. Do not discuss credentials.
`;

const BUILTIN: Record<string, string> = {
  'wide-research': WIDE_RESEARCH,
  forget: FORGET,
  'self-awareness': SELF_AWARENESS,
};

const DEFAULT_INDEX = {
  version: 1,
  skills: [
    {
      id: 'wide-research',
      enabled: true,
      requiresTools: ['create_work', 'web_search', 'work_status'],
      toolBindings: { create_work: 'create_work', web_search: 'web_search', work_status: 'work_status' },
    },
    {
      id: 'forget',
      enabled: true,
      requiresTools: ['memory_forget'],
      toolBindings: { memory_forget: 'memory_forget', memory_explain: 'memory_explain', memory_search: 'memory_search' },
    },
    {
      id: 'self-awareness',
      enabled: true,
      requiresTools: [],
      toolBindings: {},
    },
  ],
};

export function ensureSkills(dataDirectory: string): { created: string[]; problems: string[] } {
  const root = scopeRoot(dataDirectory);
  const created: string[] = [];
  const problems: string[] = [];
  const index = readBounded(root, ['skills-index.json'], INDEX_LIMIT);
  if (!index.ok && index.reason === 'missing') {
    const wrote = createBoundedIfAbsent(root, ['skills-index.json'], `${JSON.stringify(DEFAULT_INDEX, null, 2)}\n`, INDEX_LIMIT);
    if (!wrote.ok) problems.push(`skills-index.json is ${ioDetail(wrote.reason)}`);
    else if (wrote.created) created.push('skills-index.json');
  } else if (!index.ok) problems.push(`skills-index.json is ${ioDetail(index.reason)}`);
  for (const [id, text] of Object.entries(BUILTIN)) {
    const path = ['skills', id, 'SKILL.md'];
    const current = readBounded(root, path, SKILL_LIMIT);
    if (current.ok) continue;
    if (current.reason !== 'missing') { problems.push(`${id}/SKILL.md is ${ioDetail(current.reason)}`); continue; }
    const wrote = createBoundedIfAbsent(root, path, text, SKILL_LIMIT);
    if (!wrote.ok) problems.push(`${id}/SKILL.md is ${ioDetail(wrote.reason)}`);
    else if (wrote.created) created.push(`${id}/SKILL.md`);
  }
  return { created, problems };
}

/** Compatibility facade: discovery is metadata-only, never a keyword body router. */
export function selectSkills(_dataDirectory: string, _prompt: string, _toolNames: readonly string[], _kind: string, _registeredNames: readonly string[] = KNOWN_TOOLS): SkillSelection {
  return { loaded: [], notes: ['Skill bodies require an explicit skill_read call. Use the published skill catalog or skills_list.'] };
}

/** Legacy shape, backed by the same strict standard/legacy metadata parser as discovery. */
export function parseSkillMarkdown(text: string, expectedId: string): { ok: true; description: string; body: string } | { ok: false; reason: string } {
  try {
    const metadata = parseSkill(text, expectedId);
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const end = normalized.indexOf('\n---\n', 4);
    return { ok: true, description: metadata.description, body: normalized.slice(end + 5).trim() };
  } catch (error) {
    return { ok: false, reason: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'INVALID_FRONTMATTER' };
  }
}
