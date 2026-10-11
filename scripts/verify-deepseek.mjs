import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

process.loadEnvFile(resolve('.env'));
const base = process.env.KLEIO_MODEL_BASE_URL;
const model = process.env.KLEIO_MODEL_ID;
const key = process.env.KLEIO_MODEL_API_KEY;
if (!base || !model || !key) throw new Error('Local model configuration is incomplete');
const report = { date: new Date().toISOString(), provider: new URL(base).origin, model, checks: [], usage: [] };
async function complete(messages, tools) {
  const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, thinking: { type: 'disabled' }, max_tokens: 160 }),
  });
  if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const result = await response.json();
  report.usage.push(result.usage);
  if (result.model !== model) throw new Error('Unexpected model response');
  const message = result.choices?.[0]?.message;
  if (!message) throw new Error('Missing model response');
  return message;
}
const messages = [{ role: 'user', content: '请调用 multiply 工具计算 27 乘 39。调用后只回复计算结果。' }];
const tools = [{ type: 'function', function: { name: 'multiply', description: 'Multiply two integers.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } } }];
const call = await complete(messages, tools);
const invocation = call.tool_calls?.find(item => item.function.name === 'multiply');
if (!invocation) throw new Error('The model did not call the requested tool');
const args = JSON.parse(invocation.function.arguments);
if (args.a !== 27 || args.b !== 39) throw new Error('Unexpected tool arguments');
report.checks.push({ id: 'real-model-tool-call', status: 'passed', name: 'multiply', arguments: args });
const answer = await complete([...messages, call, { role: 'tool', tool_call_id: invocation.id, content: JSON.stringify({ result: args.a * args.b }) }], tools);
if (!answer.content?.includes('1053')) throw new Error('The model did not use the tool result');
report.checks.push({ id: 'tool-result-roundtrip', status: 'passed', answer: answer.content });
await mkdir('docs/native-v0.2-evidence', { recursive: true });
await writeFile('docs/native-v0.2-evidence/provider.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ model, checks: report.checks, totalTokens: report.usage.reduce((sum, value) => sum + (value?.total_tokens ?? 0), 0) }, null, 2));
