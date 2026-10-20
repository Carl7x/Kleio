import { LOCAL_SCOPE_ID, type StandingPublishedStatus } from '../context-contracts/context.ts';
import type { StandingName, Tone } from './standing-source.ts';
import { StandingStore } from './standing-store.ts';

export {
  DEFAULT_NAME,
  DEFAULT_TONE,
  ensureStanding,
  ioDetail,
  parseIdentity,
  STANDING_FILES,
  STANDING_LIMIT,
  STANDING_TEMPLATES,
  STANDING_UNAVAILABLE,
  StandingStoreError,
  TONES,
  validateName,
  validateTone,
  writeIdentityFields,
} from './standing-source.ts';
export type { StandingName, Tone };
export { StandingStore };

export interface StandingFileState {
  name: StandingName;
  status: StandingPublishedStatus;
  text: string;
  detail: string;
}

export interface StandingSnapshot {
  files: StandingFileState[];
  name: string;
  tone: Tone;
  nameDetail: string;
  toneDetail: string;
  defaultTemplate: boolean;
  problems: string[];
}

/** Local compatibility read. Uses StandingStore and returns a mutable projection of that snapshot. */
export function loadStanding(dataDirectory: string): StandingSnapshot {
  const snapshot = new StandingStore({ dataDirectory, scopeId: LOCAL_SCOPE_ID }).read();
  return {
    files: snapshot.files.map(file => ({
      name: file.name,
      status: file.status,
      text: file.text,
      detail: file.detail,
    })),
    name: snapshot.name,
    tone: snapshot.tone,
    nameDetail: snapshot.nameDetail,
    toneDetail: snapshot.toneDetail,
    defaultTemplate: snapshot.defaultTemplate,
    problems: [...snapshot.problems],
  };
}
