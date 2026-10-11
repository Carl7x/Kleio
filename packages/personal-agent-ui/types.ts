export interface Source { sessionId?: string; turnId?: string; messageId?: string; kind?: string; }
export interface Memory { id: string; subject: string; key: string; text: string; version: number; deleted: boolean; source: Source; updatedAt: string; }
export interface Revision { version: number; operation: string; record: Memory; source: Source; createdAt: string; }
export interface Candidate { id: string; subject: string; key: string; text: string; version: number; status: string; source: Source; sourceQuote?: string; createdAt: string; conflict?: { id: string; version: number; text: string }; }
export interface MemoryCapture { started: boolean; jobs: Partial<Record<'queued' | 'running' | 'completed' | 'failed' | 'skipped', number>>; latestJob?: { status: string; skipReason?: string; errorCode?: string; createdAt: string; endedAt?: string; sessionId?: string }; }
export interface Profile { version: number; assistant: { name: string; tone: string; instructions: string }; user: { name: string; language: string; timeZone: string }; captureEnabled: boolean; }
export interface Task { id: string; title: string; goal: string; status: string; runId?: string; sessionId?: string; createdAt: string; updatedAt: string; error?: string | { message?: string }; summary?: string; uncertainEffects?: boolean; cancelRequested?: boolean; waitingReason?: string; }
export interface Artifact { id: string; taskId?: string; sessionId: string; path: string; title?: string; cwd?: string; resourceAddress?: string; type?: string; createdAt?: string; }
export interface TaskDetail { task: Task; runs: Array<{ id: string; status: string; dispatched?: boolean; createdAt?: string; startedAt?: string; endedAt?: string }>; events: Array<{ seq: number; type: string; data?: { tool?: string; message?: string }; createdAt?: string }>; artifacts: Artifact[]; }
export interface Navigation {
  openSession: (id: string) => void;
  startSession: (prompt?: string) => void;
  openArtifact: (item: Artifact) => Promise<void>;
}
