/** Join ACP text blocks without losing the boundary between tool-separated messages. */
export class DshTextOutput {
  private content = '';
  private messageId: string | undefined;
  private toolBoundary = false;
  get text(): string { return this.content; }

  accept(update: Record<string, unknown>): string {
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.toolBoundary = true;
      return '';
    }
    if (update.sessionUpdate !== 'agent_message_chunk') return '';
    const block = update.content;
    if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string' || !block.text) return '';
    const nextId = typeof update.messageId === 'string' ? update.messageId : undefined;
    let separator = '';
    // The pinned ACP runtime supplies messageId for all blocks of one committed
    // assistant message. Older peers lacking that extension use the tool boundary.
    if (this.toolBoundary && (nextId === undefined || this.messageId === undefined || nextId !== this.messageId)) {
      if (this.content) {
        const trailing = this.content.match(/(?:\r?\n)+$/u)?.[0].match(/\n/gu)?.length ?? 0;
        const leading = block.text.match(/^(?:\r?\n)+/u)?.[0].match(/\n/gu)?.length ?? 0;
        separator = '\n'.repeat(Math.max(0, 2 - trailing - leading));
      }
      this.toolBoundary = false;
    }
    this.messageId = nextId;
    const delta = separator + block.text;
    this.content += delta;
    return delta;
  }
}
