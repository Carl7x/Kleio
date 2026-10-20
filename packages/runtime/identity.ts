import { RuntimeError } from './contracts.ts';
import { ensureStanding, ioDetail, loadStanding, TONES, writeIdentityFields, type Tone } from '../product-context/index.ts';
import type { RuntimeStore } from './store.ts';

export interface PresentationIdentity {
  name: string;
  tone: Tone;
  avatar: 'sky' | 'sand' | 'lilac';
  showChatUpdates: boolean;
}

const AVATARS = ['sky', 'sand', 'lilac'] as const;
type Avatar = typeof AVATARS[number];

interface StoredIdentity {
  name: string;
  tone: string;
  avatar: Avatar;
  showChatUpdates: boolean;
}

/**
 * Name and tone authority, highest first:
 * 1. A valid standing/IDENTITY.md field, read on every request.
 * 2. Product default Kleio / warm when the file is missing, blank, or invalid.
 * 3. openmuse.identity is only the presentation mirror (avatar, showChatUpdates, and a copy of the effective name and tone).
 * The mirror is seeded into a newly created IDENTITY.md once. After that, file edits win and the mirror is updated to match.
 * Startup never overwrites an existing standing file.
 */
export function migrateStandingIdentity(store: RuntimeStore, dataDirectory: string): void {
  const ensured = ensureStanding(dataDirectory);
  if (!ensured.created.includes('IDENTITY.md')) return;
  const stored = readStored(store);
  if (!stored) return;
  const tone = TONES.find(item => item === stored.tone);
  if (!tone) return;
  writeIdentityFields(dataDirectory, { name: stored.name, tone });
}

export function currentAgentIdentity(store: RuntimeStore, dataDirectory: string): PresentationIdentity {
  ensureStanding(dataDirectory);
  const standing = loadStanding(dataDirectory);
  const stored = readStored(store);
  const identity: PresentationIdentity = {
    name: standing.name,
    tone: standing.tone,
    avatar: stored?.avatar ?? 'sky',
    showChatUpdates: stored?.showChatUpdates ?? true,
  };
  if (stored && (stored.name !== identity.name || stored.tone !== identity.tone || stored.avatar !== identity.avatar || stored.showChatUpdates !== identity.showChatUpdates)) {
    const raw = store.getSetting<Record<string, unknown> | null>('openmuse.identity', null);
    store.setSetting('openmuse.identity', { ...(raw ?? {}), ...identity });
  }
  return identity;
}

export function saveAgentIdentity(store: RuntimeStore, dataDirectory: string, input: { name: string; tone: Tone; avatar?: Avatar; showChatUpdates?: boolean }): PresentationIdentity {
  const current = currentAgentIdentity(store, dataDirectory);
  const wrote = writeIdentityFields(dataDirectory, { name: input.name, tone: input.tone });
  if (!wrote.ok) throw new RuntimeError('invalid_standing', `IDENTITY.md is ${ioDetail(wrote.reason)}`, 409);
  const identity: PresentationIdentity = {
    name: input.name.trim(),
    tone: input.tone,
    avatar: input.avatar ?? current.avatar,
    showChatUpdates: input.showChatUpdates ?? current.showChatUpdates,
  };
  const raw = store.getSetting<Record<string, unknown> | null>('openmuse.identity', null);
  store.setSetting('openmuse.identity', { ...(raw ?? {}), ...identity });
  return identity;
}

function readStored(store: RuntimeStore): StoredIdentity | null {
  const raw = store.getSetting<unknown>('openmuse.identity', null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const avatar = AVATARS.find(item => item === value.avatar) ?? 'sky';
  return {
    name: typeof value.name === 'string' ? value.name : 'Kleio',
    tone: typeof value.tone === 'string' ? value.tone : 'warm',
    avatar,
    showChatUpdates: value.showChatUpdates !== false,
  };
}
