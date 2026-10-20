import { setTimeout as delay } from 'node:timers/promises';
import type { SSEStreamingApi } from 'hono/streaming';
import type { RuntimeStore } from '../../packages/runtime/store.ts';

/** Timing injection is for bounded lifecycle tests, never user configuration. */
export interface ConversationStreamTiming { pollMs?: number; heartbeatMs?: number; lifetimeMs?: number }

export async function streamConversationChanges(stream: SSEStreamingApi, store: RuntimeStore, conversationId: string,
  after: number, signal: AbortSignal, timing: ConversationStreamTiming = {}): Promise<void> {
  const controller = new AbortController();
  const stop = () => { controller.abort(); stream.abort(); };
  stream.onAbort(() => controller.abort());
  signal.addEventListener('abort', stop, { once: true });
  const deadline = setTimeout(stop, timing.lifetimeMs ?? 30_000);
  try {
    if (signal.aborted || stream.aborted) { stop(); return; }
    await stream.write(': connected\n\n');
    let heartbeatAt = Date.now();
    while (!controller.signal.aborted) {
      const change = store.conversationChange(conversationId);
      if (change.sequence > after) {
        await stream.writeSSE({ id: String(change.sequence), event: 'conversation.changed', data: JSON.stringify(change) });
        after = change.sequence;
      }
      if (Date.now() - heartbeatAt >= (timing.heartbeatMs ?? 15_000)) {
        await stream.write(': heartbeat\n\n');
        heartbeatAt = Date.now();
      }
      await delay(timing.pollMs ?? 250, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', stop);
  }
}
