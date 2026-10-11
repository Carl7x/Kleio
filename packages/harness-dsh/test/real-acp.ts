/** Keyless integration probe: published dsh process + localhost scripted model. */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DshAcpClient, type DshAcpEvent, type DshPermissionRequest } from '../src/index.ts';

const runtime = resolve('packages/harness-dsh/.runtime');
const evidence = resolve('docs/project-teardowns-2026-10-11/evidence/dsh');
const home = resolve(runtime, 'probe-home');
const workspace = resolve(runtime, 'probe-workspace', String(Date.now()));
await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(evidence, { recursive: true })]);
const requests: Array<{ latestUser: string; toolNames: string[]; historyContainsFirstAnswer: boolean }> = [];
const permissions: Array<{ sessionId: string; toolCallId: unknown; options: string[] }> = [];
const events: DshAcpEvent[] = [];
let heldCancelled = false;
let heldAdmitted: (() => void) | undefined;
const heldReady = new Promise<void>(resolve => { heldAdmitted = resolve; });
let count = 0;

function flatten(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatten).join('\n');
  if (value && typeof value === 'object' && 'text' in value) return flatten(value.text);
  return '';
}

const server = createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'probe-model', object: 'model' }] }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ function: { name: string } }> }>;
    tools?: Array<{ function: { name: string } }>;
  };
  const latestUserIndex = body.messages.findLastIndex(message => message.role === 'user' && /ACP-(FIRST|CANCEL|ARTIFACT|PERMISSION|RESUME)-PROBE/.test(flatten(message.content)));
  const latestUser = flatten(body.messages[latestUserIndex]?.content);
  const toolNames = body.tools?.map(tool => tool.function.name) ?? [];
  const history = body.messages.map(message => flatten(message.content)).join('\n');
  requests.push({ latestUser, toolNames, historyContainsFirstAnswer: history.includes('ACP-FIRST-ANSWER') });
  if (latestUser.includes('ACP-CANCEL-PROBE')) {
    res.setHeader('content-type', 'text/event-stream');
    res.flushHeaders();
    heldAdmitted?.();
    res.on('close', () => { heldCancelled = true; });
    return;
  }
  const afterUser = body.messages.slice(latestUserIndex + 1);
  const previousTools = afterUser.flatMap(message => message.tool_calls?.map(call => call.function.name) ?? []);
  let tool: { name: string; arguments: string } | undefined;
  let text = 'ACP-FIRST-ANSWER';
  if (latestUser.includes('ACP-ARTIFACT-PROBE')) {
    if (!previousTools.includes('write')) tool = { name: 'write', arguments: JSON.stringify({ file_path: 'artifact-probe.txt', content: 'A real dsh tool wrote this local test artifact.\n', sandbox_permissions: 'workspace-write', justification: 'Create the isolated integration test artifact.' }) };
    else if (!previousTools.includes('present')) tool = { name: 'present', arguments: JSON.stringify({ files: [{ path: 'artifact-probe.txt', description: 'Keyless dsh integration artifact' }] }) };
    else text = 'ACP-ARTIFACT-DONE';
  } else if (latestUser.includes('ACP-PERMISSION-PROBE')) {
    if (!previousTools.includes('write')) tool = { name: 'write', arguments: JSON.stringify({ file_path: 'permission-probe.txt', content: 'Approved once by the probe.\n', sandbox_permissions: 'workspace-write', justification: 'Create the isolated approval test file.' }) };
    else text = 'ACP-PERMISSION-DONE';
  } else if (latestUser.includes('ACP-RESUME-PROBE')) text = history.includes('ACP-FIRST-ANSWER') ? 'ACP-RESUME-HISTORY-PRESENT' : 'ACP-RESUME-HISTORY-MISSING';
  const id = `scripted-${++count}`;
  const frame = (delta: unknown, finishReason: string | null = null): string => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'probe-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  res.setHeader('content-type', 'text/event-stream');
  res.write(frame({ role: 'assistant', content: '' }));
  if (tool) res.write(frame({ tool_calls: [{ index: 0, id: `tool-${count}`, type: 'function', function: tool }] }));
  else res.write(frame({ content: text }));
  res.write(frame({}, tool ? 'tool_calls' : 'stop'));
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'probe-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('Local model server did not bind');
const patch = resolve(runtime, 'probe.patch.yml');
await writeFile(patch, `- id: llm-pi-ai\n  config:\n    providers:\n      local-probe:\n        apiKeyEnv: DSH_PROBE_API_KEY\n        api: openai-completions\n        baseURL: http://127.0.0.1:${address.port}/v1\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n        models:\n          - id: probe-model\n            contextWindow: 32768\n            maxTokens: 4096\n            reasoningEfforts: false\n- id: acp\n  config:\n    provider: local-probe\n    model: probe-model\n- id: agent-default-model\n  config:\n    provider: local-probe\n    model: probe-model\n- insert:\n    - id: probe-present\n      name: '@deepseek-ai/dsh-tool-present'\n`, 'utf8');

// No inherited API tokens: only OS launch essentials and the localhost placeholder.
const env: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PATHEXT', 'COMSPEC']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, { DSH_HOME: home, DSH_PROBE_API_KEY: 'localhost-placeholder', DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_DISABLED: '1' });
const onPermission = (request: DshPermissionRequest): string | null => {
  permissions.push({ sessionId: request.sessionId, toolCallId: request.toolCall.toolCallId, options: request.options.map(option => option.kind) });
  return request.options.find(option => option.kind === 'allow_once')?.optionId ?? null;
};
const create = (): DshAcpClient => new DshAcpClient({ command: process.execPath, args: [resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'acp', '--patch', patch], cwd: workspace, env, requestTimeoutMs: 90_000, promptTimeoutMs: 20_000, closeTimeoutMs: 3_000, onPermission, onEvent: event => events.push(event) });

const result: Record<string, unknown> = { runtime: '@deepseek-ai/dsh@0.2.1-alpha.2', model: 'scripted localhost OpenAI-compatible endpoint', realPaidModel: false, beganAt: new Date().toISOString() };
let adapter = create();
try {
  const initialized = await adapter.start();
  result.initialize = initialized;
  const session = await adapter.createSession({ cwd: workspace });
  result.sessionId = session.sessionId;
  result.prompt = await adapter.prompt({ sessionId: session.sessionId, text: 'ACP-FIRST-PROBE' });
  const held = await adapter.createSession({ cwd: workspace });
  const cancelling = adapter.prompt({ sessionId: held.sessionId, text: 'ACP-CANCEL-PROBE' });
  await heldReady;
  adapter.cancel(held.sessionId);
  result.cancel = await cancelling;
  result.permission = await adapter.prompt({ sessionId: session.sessionId, text: 'ACP-PERMISSION-PROBE' });
  result.permissionFile = await readFile(resolve(workspace, 'permission-probe.txt'), 'utf8');
  result.artifact = await adapter.prompt({ sessionId: session.sessionId, text: 'ACP-ARTIFACT-PROBE' });
  result.artifactFile = await readFile(resolve(workspace, 'artifact-probe.txt'), 'utf8');
  result.listBeforeRestart = await adapter.listSessions({ cwd: workspace });
  await adapter.close();
  adapter = create();
  result.resume = await adapter.resumeSession({ sessionId: session.sessionId, cwd: workspace });
  result.resumePrompt = await adapter.prompt({ sessionId: session.sessionId, text: 'ACP-RESUME-PROBE' });
  const presented = events.some(event => event.update.sessionUpdate === 'tool_call' && event.update.title === 'present' && events.some(done => done.update.sessionUpdate === 'tool_call_update' && done.update.toolCallId === event.update.toolCallId && done.update.status === 'completed'));
  const resumedWithHistory = events.some(event => event.update.sessionUpdate === 'agent_message_chunk' && flatten(event.update.content).includes('ACP-RESUME-HISTORY-PRESENT'));
  if (result.cancel && (result.cancel as { stopReason: string }).stopReason !== 'cancelled') throw new Error('Cancellation did not settle as cancelled');
  if (permissions.length < 2 || !presented || !resumedWithHistory) throw new Error('Approval, delivery or resume check did not pass');
  result.presentedToolSucceeded = presented;
  result.resumedHistoryVerified = resumedWithHistory;
  result.status = 'completed';
} catch (error) {
  result.status = 'failed';
  result.error = error instanceof Error ? { name: error.name, message: error.message } : { message: 'Unknown error' };
  process.exitCode = 1;
} finally {
  await adapter.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  Object.assign(result, { heldModelConnectionCancelled: heldCancelled, permissions, events, modelRequests: requests, endedAt: new Date().toISOString() });
  await writeFile(resolve(evidence, 'real-acp-probe.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: result.status, error: result.error, permissions: permissions.length, updates: events.length, modelRequests: requests.length, evidence: resolve(evidence, 'real-acp-probe.json') }));
}
