// Protocol peer only: this fixture is not DeepSeek Harness or a model.
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const active = new Map();
const permissions = new Map();
let counter = 0;
const send = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const answer = (id, result) => send({ id, result });
const update = (sessionId, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

lines.on('line', line => {
  const frame = JSON.parse(line);
  const p = frame.params ?? {};
  if (frame.method === 'initialize') answer(frame.id, { protocolVersion: 1, agentCapabilities: {} });
  else if (frame.method === 'session/new') answer(frame.id, { sessionId: `fixture-${++counter}` });
  else if (frame.method === 'session/resume') answer(frame.id, {});
  else if (frame.method === 'session/list') answer(frame.id, { sessions: [] });
  else if (frame.method === 'session/close') {
    const running = active.get(p.sessionId);
    if (running) { answer(running, { stopReason: 'cancelled' }); active.delete(p.sessionId); }
    answer(frame.id, {});
  } else if (frame.method === 'session/cancel') {
    const running = active.get(p.sessionId);
    if (running && process.env.FIXTURE_IGNORE_CANCEL !== '1') { answer(running, { stopReason: 'cancelled' }); active.delete(p.sessionId); }
  } else if (frame.method === 'session/prompt') {
    const text = p.prompt[0].text;
    if (text === 'malformed') process.stdout.write('this is not JSON\n');
    else if (text === 'hold') { active.set(p.sessionId, frame.id); update(p.sessionId, 'working'); }
    else if (text === 'permission') {
      const id = `permission-${++counter}`;
      permissions.set(id, { promptId: frame.id, sessionId: p.sessionId });
      send({ id, method: 'session/request_permission', params: { sessionId: p.sessionId, toolCall: { toolCallId: id, title: 'Read isolated fixture', kind: 'read' }, options: [
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      ] } });
    } else { update(p.sessionId, text); answer(frame.id, { stopReason: 'end_turn' }); }
  } else if (permissions.has(frame.id)) {
    const pending = permissions.get(frame.id);
    permissions.delete(frame.id);
    update(pending.sessionId, JSON.stringify(frame.result));
    answer(pending.promptId, { stopReason: 'end_turn' });
  } else if (frame.id !== undefined) send({ id: frame.id, error: { code: -32601, message: 'Unknown fixture method' } });
});
lines.on('close', () => process.exit(0));
