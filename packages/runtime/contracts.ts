export type ExecutionKind = 'conversation' | 'memory' | 'research' | 'review';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ExecutionInput {
  id: string;
  kind: ExecutionKind;
  prompt: string;
  context: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: ToolDefinition[];
}

export interface ExecutionContext {
  signal: AbortSignal;
  onText(text: string): void;
  onEvent(event: { type: string; data?: Record<string, unknown> }): void;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface Engine {
  readonly id: string;
  execute(input: ExecutionInput, context: ExecutionContext): Promise<{ text: string; engineSessionId?: string }>;
  close(): Promise<void>;
}

export class RuntimeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message); this.name = 'RuntimeError';
  }
}
