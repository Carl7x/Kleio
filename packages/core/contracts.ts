import { z } from 'zod';

export const statusSchema = z.enum(['queued', 'running', 'waiting_approval', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted']);
export type RunStatus = z.infer<typeof statusSchema>;
export const taskSchema = z.object({ id: z.string(), title: z.string(), prompt: z.string(), status: statusSchema,
  conversationId: z.string().nullable().default(null),
  currentRunId: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });
export type Task = z.infer<typeof taskSchema>;
export const runSchema = z.object({ id: z.string(), taskId: z.string(), engine: z.string(), status: statusSchema,
  conversationId: z.string().nullable().default(null),
  sessionId: z.string().nullable(), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });
export type Run = z.infer<typeof runSchema>;
export const conversationSchema = z.object({ id: z.string(), title: z.string(), activeRunId: z.string().nullable(),
  lastRunId: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });
export type Conversation = z.infer<typeof conversationSchema>;
export const messageSchema = z.object({ id: z.string(), sequence: z.number().int().positive(), conversationId: z.string(),
  role: z.enum(['user', 'assistant']), content: z.string(), taskId: z.string(), runId: z.string().nullable(),
  status: z.union([z.literal('sent'), statusSchema]), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });
export type Message = z.infer<typeof messageSchema>;
export interface MessageSubmission { conversationId: string; messageId: string; taskId: string; runId: string; replayed: boolean }
export const eventSchema = z.object({ sequence: z.number(), runId: z.string(), type: z.string(),
  data: z.record(z.string(), z.unknown()), createdAt: z.string() });
export type AgentEvent = z.infer<typeof eventSchema>;
export const memorySchema = z.object({ id: z.string(), text: z.string(), source: z.string(),
  scope: z.string(), kind: z.enum(['explicit', 'inferred', 'observation']), version: z.number(),
  pinned: z.boolean(), deleted: z.boolean(), updatedAt: z.string() });
export type Memory = z.infer<typeof memorySchema>;
export const approvalSchema = z.object({ id: z.string(), runId: z.string(), kind: z.string(),
  payload: z.record(z.string(), z.unknown()), hash: z.string(), status: z.enum(['pending', 'approved', 'rejected', 'expired', 'interrupted']),
  expiresAt: z.string(), createdAt: z.string() });
export type Approval = z.infer<typeof approvalSchema>;
export const artifactSchema = z.object({ id: z.string(), runId: z.string(), title: z.string(), content: z.string(),
  mediaType: z.literal('text/markdown'), createdAt: z.string() });
export type Artifact = z.infer<typeof artifactSchema>;

export interface EngineInput { runId: string; prompt: string; memories: Memory[]; sessionId: string | null;
  /** Bounded application history; engines with native sessions need not append it to their prompt. */
  history?: Array<Pick<Message, 'role' | 'content'>> }
export interface EngineContext {
  signal: AbortSignal;
  onText(text: string): void;
  onSession(sessionId: string): void;
  requestApproval(kind: string, payload: Record<string, unknown>): Promise<boolean>;
}
export interface AgentEngine {
  readonly id: string;
  readonly capabilities: { cancel: boolean; permissions: boolean; resume: boolean; steer: boolean };
  execute(input: EngineInput, context: EngineContext): Promise<{ text: string }>;
  close(): Promise<void>;
}

/** Distinguishes invalid or stale product operations from engine failures. */
export class CoreError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'CoreError'; }
}

/** The engine has acknowledged cancellation or has stopped its local work. */
export class CancellationConfirmedError extends Error {
  constructor() { super('执行已确认停止。'); this.name = 'CancellationConfirmedError'; }
}

/** A transport failure does not establish whether an external action happened. */
export class EngineOutcomeUnknownError extends Error {
  constructor(message: string) { super(message); this.name = 'EngineOutcomeUnknownError'; }
}
