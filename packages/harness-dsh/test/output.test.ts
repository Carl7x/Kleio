import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DshTextOutput } from '../../engines/dsh-output.ts';
import { createDshEngine } from '../../engines/dsh.ts';

const text = (value: string, messageId?: string) => ({ sessionUpdate: 'agent_message_chunk', ...(messageId ? { messageId } : {}), content: { type: 'text', text: value } });
const tool = { sessionUpdate: 'tool_call', toolCallId: 'one' };

test('ACP text blocks preserve raw chunks and separate new messages after tools', () => {
  const output = new DshTextOutput();
  assert.equal(output.accept(text('先查看', 'first')), '先查看');
  assert.equal(output.accept(text('来源。', 'first')), '来源。');
  output.accept(tool);
  assert.equal(output.accept({ sessionUpdate: 'agent_thought_chunk', messageId: 'second', content: { type: 'text', text: 'private thought' } }), '');
  assert.equal(output.accept(text('', 'second')), '');
  assert.equal(output.accept(text('# 标', 'second')), '\n\n# 标');
  assert.equal(output.accept(text('题\n\n正文。', 'second')), '题\n\n正文。');
  assert.equal(output.text, '先查看来源。\n\n# 标题\n\n正文。');
});

test('paragraph separator respects existing newlines, first output, and same-message blocks', () => {
  for (const [before, after, expected] of [
    ['已有段落\n\n', '# 标题', '已有段落\n\n# 标题'],
    ['已有段落\r\n\r\n', '# 标题', '已有段落\r\n\r\n# 标题'],
    ['已有段落\n', '\n# 标题', '已有段落\n\n# 标题'],
    ['已有段落', '\n# 标题', '已有段落\n\n# 标题'],
    ['已有段落', '\n\n# 标题', '已有段落\n\n# 标题'],
  ]) {
    const output = new DshTextOutput();
    output.accept(text(before!, 'first')); output.accept(tool); output.accept(text(after!, 'second'));
    assert.equal(output.text, expected);
  }
  const output = new DshTextOutput();
  output.accept(tool);
  output.accept(text('{"decision":', 'json'));
  output.accept({ sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'completed' });
  assert.equal(output.accept(text('"notify","text":"中文结果"}', 'json')), '"notify","text":"中文结果"}');
  assert.deepEqual(JSON.parse(output.text), { decision: 'notify', text: '中文结果' });
  const legacy = new DshTextOutput();
  legacy.accept(text('旧协议片段')); legacy.accept(tool);
  assert.equal(legacy.accept(text('下一段')), '\n\n下一段');
});

test('real pinned ACP separates multiple tool rounds and keeps strict JSON output intact', { timeout: 60_000 }, async t => {
  if (!existsSync(fileURLToPath(new URL('../.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)))) return t.skip('The optional pinned runtime is not installed.');
  const directory = await mkdtemp(join(tmpdir(), 'kleio-output-'));
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const jsonMode = JSON.stringify(body.messages).includes('STRICT_JSON_REGRESSION');
    const round = body.messages.filter((message: { role: string }) => message.role === 'tool').length;
    const needsTool = !jsonMode && round < 2;
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: `local-${requests.length}`, object: 'chat.completion.chunk', model: 'local-model', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.setHeader('content-type', 'text/event-stream');
    res.write(frame({ role: 'assistant', content: '' }));
    res.write(frame({ reasoning_content: 'HIDDEN_THOUGHT' }));
    const parts = jsonMode ? ['{"decision":"notify",', '"text":"中文结果"}'] : round === 0 ? ['先查看', '来源。'] : round === 1 ? ['继续', '核对。'] : ['# 标题\n\n', '最终正文。'];
    for (const content of parts) res.write(frame({ content }));
    if (needsTool) res.write(frame({ tool_calls: [{ index: 0, id: `tool-${round}`, type: 'function', function: { name: 'mcp__kleio__lookup', arguments: JSON.stringify({ query: `round-${round}` }) } }] }));
    res.write(frame({}, needsTool ? 'tool_calls' : 'stop'));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address(); assert(address && typeof address !== 'string');
  const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${address.port}/v1`, id: 'local-model', apiKey: 'local-placeholder' }, promptTimeoutMs: 20_000 });
  const deltas: string[] = [];
  const toolEvents: Record<string, unknown>[] = [];
  const calls: unknown[] = [];
  try {
    const result = await engine.execute({ id: 'paragraphs', kind: 'research', prompt: '检查工具后段落 TOOL_PARAGRAPH_REGRESSION', context: '', history: [], tools: [{ name: 'lookup', description: 'Read local test evidence.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] }, {
      signal: new AbortController().signal, onText(delta) { deltas.push(delta); }, onEvent(event) { if (event.type === 'engine.tool') toolEvents.push(event.data!); }, async callTool(name, args) { calls.push({ name, args }); return { found: true }; },
    });
    assert.equal(result.text, '先查看来源。\n\n继续核对。\n\n# 标题\n\n最终正文。');
    assert.equal(deltas.join(''), result.text);
    assert.deepEqual(calls, [{ name: 'lookup', args: { query: 'round-0' } }, { name: 'lookup', args: { query: 'round-1' } }]);
    assert.equal(toolEvents.filter(event => event.sessionUpdate === 'tool_call').length, 2);
    assert.equal(toolEvents.filter(event => event.sessionUpdate === 'tool_call_update').length, 2);
    const jsonDeltas: string[] = [];
    const strict = await engine.execute({ id: 'json', kind: 'review', prompt: 'STRICT_JSON_REGRESSION', context: 'Return only JSON {"decision":"notify","text":"中文结果"}.', history: [], tools: [] }, {
      signal: new AbortController().signal, onText(delta) { jsonDeltas.push(delta); }, onEvent() {}, async callTool() { assert.fail('No tools available'); },
    });
    assert.equal(strict.text, '{"decision":"notify","text":"中文结果"}');
    assert.equal(jsonDeltas.join(''), strict.text);
    assert.equal(requests.length, 4);
    const system = JSON.stringify(requests[0]!.messages.filter(message => message.role === 'system'));
    assert.match(system, /Write every user-visible message in the language requested by the current request/u);
    assert.match(system, /Perform routine read tools silently/u);
    assert.match(system, /return only that JSON with the prescribed keys and enum values/u);
    assert.deepEqual(await readdir(join(directory, 'executions')), []);
  } finally {
    await engine.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
