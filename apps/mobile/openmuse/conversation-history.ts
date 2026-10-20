import type { Execution, Message as SavedMessage, ProductEvent } from "../src/api";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolMessage = { id: string; role: "tool"; toolCallId: string; content: string };
export type Message =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | ToolMessage;
type AssistantMessage = Extract<Message, { role: "assistant" }>;

const displayToolName = (name: string) => ({ web_search: "search_web", create_work: "delegate_task", work_status: "agent_status", memory_correct: "remember_fact" } as Record<string, string>)[name] ?? name;

/** Preserve the original assistant text → tool calls → next assistant text order. */
export function executionMessages(execution: Execution, events: readonly ProductEvent[], fallback = ""): Message[] {
  const messages: Message[] = [];
  let current: AssistantMessage | undefined;
  let afterTool = false;
  const tools = new Map<string, ToolCall>();
  const makeMessage = (sequence: number) => {
    const next: AssistantMessage = { id: `${execution.id}:assistant:${sequence}`, role: "assistant", content: "" };
    messages.push(next);
    current = next;
    return next;
  };
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const data = event.data;
    if (event.type === "text.delta" && typeof data.text === "string" && data.text) {
      if (!current || afterTool) makeMessage(event.sequence);
      current!.content += data.text;
      afterTool = false;
    } else if (event.type === "tool.started" && typeof data.callId === "string" && typeof data.name === "string") {
      if (tools.has(data.callId)) continue;
      const call: ToolCall = { id: data.callId, type: "function", function: { name: displayToolName(data.name), arguments: JSON.stringify(data.args ?? {}) } };
      if (!current) makeMessage(event.sequence);
      current!.toolCalls = [...(current!.toolCalls ?? []), call];
      tools.set(call.id, call);
      afterTool = true;
    } else if ((event.type === "tool.completed" || event.type === "tool.failed") && typeof data.callId === "string") {
      if (!tools.has(data.callId) && typeof data.name === "string") {
        const call: ToolCall = { id: data.callId, type: "function", function: { name: displayToolName(data.name), arguments: "{}" } };
        if (!current) makeMessage(event.sequence);
        current!.toolCalls = [...(current!.toolCalls ?? []), call];
        tools.set(call.id, call);
      }
      const result = event.type === "tool.failed" ? { error: typeof data.error === "string" ? data.error : "工具未完成。" } : data.result ?? {};
      messages.push({ id: `${execution.id}:tool:${data.callId}`, role: "tool", toolCallId: data.callId, content: typeof result === "string" ? result : JSON.stringify(result) });
      afterTool = true;
    }
  }
  // Older saved turns without text events still retain their completed answer.
  if (!messages.some(item => item.role === "assistant" && item.content)) {
    const text = execution.text || fallback;
    if (text) makeMessage(Number.MAX_SAFE_INTEGER).content = text;
  }
  return messages;
}


/** Saved sequence anchors whole response blocks, including independent deliveries. */
export function projectConversationMessages(input: {
  readonly conversationId: string;
  readonly saved: readonly SavedMessage[];
  readonly executions: readonly Execution[];
  readonly eventsByExecution: ReadonlyMap<string, readonly ProductEvent[]>;
}): Message[] {
  const output: Message[] = [];
  const seenMessages = new Set<string>();
  const seenExecutions = new Set<string>();
  const saved = [...input.saved].filter(item => item.conversationId === input.conversationId)
    .sort((a,b) => a.sequence - b.sequence);
  const executions = input.executions.filter(item => item.conversationId === input.conversationId);
  const byExecution = new Map(executions.map(item => [item.id,item]));
  const anchored = new Set(saved.filter(item => item.role === "assistant").map(item => item.executionId));
  const appendExecution = (execution: Execution, fallback = "") => {
    if (seenExecutions.has(execution.id)) return;
    seenExecutions.add(execution.id);
    const events = new Map((input.eventsByExecution.get(execution.id) ?? [])
      .filter(event => event.executionId === execution.id).map(event => [event.sequence,event]));
    output.push(...executionMessages(execution,[...events.values()],fallback));
  };
  for (const item of saved) {
    if (seenMessages.has(item.id)) continue;
    seenMessages.add(item.id);
    if (item.role === "user") {
      output.push({id:item.id,role:"user",content:item.content});
      // In-flight and unpersisted failed attempts keep the existing user anchor.
      executions.filter(turn => turn.kind === "conversation" && !anchored.has(turn.id)
        && (turn.messageId === item.id || turn.id === item.executionId))
        .sort((a,b) => a.createdAt.localeCompare(b.createdAt))
        .forEach(turn => appendExecution(turn));
    } else {
      const execution = byExecution.get(item.executionId);
      if (execution?.kind === "conversation") appendExecution(execution,item.content);
      else if (item.status === "completed" && !seenExecutions.has(item.executionId)) {
        // Only a saved delivery is visible; background execution text/events are not.
        seenExecutions.add(item.executionId);
        output.push({id:item.id,role:"assistant",content:item.content});
      }
    }
  }
  return output;
}
