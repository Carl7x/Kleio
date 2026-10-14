import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../../packages/runtime/config.ts';

const config = loadConfig(); const base = `http://127.0.0.1:${config.port}`;
async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`); return value;
}
async function answer(conversationId: string, text: string): Promise<void> {
  const execution = await api(`/api/conversations/${conversationId}/messages`, 'POST', { text, requestId: randomUUID() });
  const response = await fetch(base + `/api/executions/${execution.id}/stream`, { headers: { Authorization: 'Bearer ' + config.token } });
  if (!response.ok || !response.body) throw new Error('Could not connect to response stream.');
  const stop = () => { void api(`/api/executions/${execution.id}/cancel`, 'POST').catch(() => {}); };
  process.once('SIGINT', stop);
  const decoder = new TextDecoder(); let buffer = '';
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }); let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === 'text.delta') stdout.write(event.data.text);
        else if (['execution.failed', 'execution.unknown', 'execution.cancelled'].includes(event.type)) stdout.write(`\n[${event.type}: ${event.data.error ?? ''}]`);
      }
    }
    stdout.write('\n');
  } finally { process.removeListener('SIGINT', stop); }
}
function display(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
const [command = 'chat', ...args] = process.argv.slice(2);
try {
  if (command === 'status') display(await api('/api/status'));
  else if (command === 'stop') display(await api('/api/shutdown', 'POST'));
  else if (command === 'work') display(args[0] ? await api('/api/work/' + args[0]) : await api('/api/work'));
  else if (command === 'cancel') display(await api('/api/work/' + args[0] + '/cancel', 'POST', {}));
  else if (command === 'inbox') display(await api('/api/notifications?unread=true'));
  else if (command === 'memory') display(await api('/api/memory'));
  else if (command === 'people') display(await api('/api/people'));
  else if (command === 'research' || command === 'remind') {
    const at = command === 'remind' ? args.shift() : undefined;
    const prompt = args.join(' '); if (!prompt) throw new Error('Provide a task description. Reminders also require an ISO timestamp with timezone.');
    display(await api('/api/work', 'POST', { requestId: randomUUID(), title: prompt.slice(0, 100), prompt, kind: command === 'remind' ? 'reminder' : 'research', ...(at ? { at } : {}) }));
  } else if (command === 'ask') {
    const conversation = await api('/api/conversations', 'POST', {}); await answer(conversation.id, args.join(' ')); console.log(`Conversation: ${conversation.id}`);
  } else if (command === 'chat') {
    let conversation = args[0] ? { id: args[0] } : await api('/api/conversations', 'POST', {});
    console.log(`Kleio · ${conversation.id}\n/new, /work, /inbox, /memory, /people, /quit. Ctrl+C during a response requests cancellation.`);
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      for (;;) {
        const text = (await readline.question('\n你 › ')).trim();
        if (!text) continue; if (text === '/quit') break;
        if (text === '/new') { conversation = await api('/api/conversations', 'POST', {}); console.log(conversation.id); continue; }
        const routes: Record<string, string> = { '/work': '/api/work', '/inbox': '/api/notifications?unread=true', '/memory': '/api/memory', '/people': '/api/people' };
        if (routes[text]) { display(await api(routes[text]!)); continue; }
        try { await answer(conversation.id, text); } catch (error) { console.error(error instanceof Error ? error.message : 'Request failed'); }
      }
    } finally { readline.close(); }
  } else throw new Error('Commands: chat [conversationId], ask, status, work [id], research, remind, cancel, inbox, memory, people, stop');
} catch (error) { console.error(error instanceof Error ? error.message.replaceAll(config.model.apiKey || '\0', '[redacted]') : 'Request failed'); process.exitCode = 1; }
