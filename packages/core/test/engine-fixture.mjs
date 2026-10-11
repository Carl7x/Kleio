// Scripted ACP peer for product mapping tests; not the real dsh runtime.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
const waiting = new Map();
const held = new Map();
let counter = 0;
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const text = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } } });
lines.on('line', line => {
  const frame = JSON.parse(line), p = frame.params ?? {};
  if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: 1 } });
  else if (frame.method === 'session/new') send({ id: frame.id, result: { sessionId: 'product-fixture-' + (++counter) } });
  else if (frame.method === 'session/resume') send({ id: frame.id, error: { code: -32000, message: 'Fixture native history is missing' } });
  else if (frame.method === 'session/close') {
    if (process.env.FIXTURE_IGNORE_CLOSE === '1') return;
    const prompt = held.get(p.sessionId);
    if (prompt) { held.delete(p.sessionId); send({ id: prompt, result: { stopReason: 'cancelled' } }); }
    send({ id: frame.id, result: {} });
  }
  else if (frame.method === 'session/cancel') {
    if (process.env.FIXTURE_IGNORE_CANCEL === '1') return;
    const prompt = held.get(p.sessionId);
    if (prompt) { held.delete(p.sessionId); send({ id: prompt, result: { stopReason: 'cancelled' } }); }
  }
  else if (frame.method === 'session/prompt') {
    const input = p.prompt[0].text;
    if (input.startsWith('hold')) { held.set(p.sessionId, frame.id); text(p.sessionId, 'HOLD-FIXTURE'); }
    else if (input.startsWith('approve') || input.startsWith('bare')) {
      const id = 'review-' + (++counter);
      if (input.startsWith('approve')) send({ method: 'session/update', params: { sessionId: p.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: id, title: 'write', kind: 'edit', rawInput: { file_path: 'isolated.txt', content: 'A' } } } });
      waiting.set(id, { id: frame.id, sessionId: p.sessionId });
      send({ id, method: 'session/request_permission', params: { sessionId: p.sessionId, toolCall: { toolCallId: id }, options: [
        { optionId: 'yes', kind: 'allow_once', name: 'Allow once' }, { optionId: 'no', kind: 'reject_once', name: 'Reject once' },
      ] } });
    } else { text(p.sessionId, 'FIXTURE: ' + input); send({ id: frame.id, result: { stopReason: 'end_turn' } }); }
  } else if (waiting.has(frame.id)) {
    const request = waiting.get(frame.id); waiting.delete(frame.id);
    if (process.env.FIXTURE_PERMISSION_RECORD) writeFileSync(process.env.FIXTURE_PERMISSION_RECORD, JSON.stringify(frame.result));
    text(request.sessionId, frame.result?.outcome?.optionId === 'yes' ? 'APPROVED-FIXTURE' : 'REJECTED-FIXTURE');
    send({ id: request.id, result: { stopReason: 'end_turn' } });
  }
});
lines.on('close', () => process.exit(0));
