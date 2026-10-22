/**
 * Opt-in live-model check for the local L1 standing loop.
 * Not part of the unit tests and not run by package test scripts unless asked.
 *
 *   node --import tsx scripts/verify-l1-live-model.ts --confirm-live-model
 *
 * Reads the existing private model endpoint in memory, then uses a temporary
 * data directory and database outside the repository. It does not print secrets,
 * write reports into the repo, or modify the private config and data.
 * It does not perform live web research. Research delivery stays in the scripted tests.
 * Exit 0 means the automatic structural and state checks passed. It does not
 * judge whether a capability answer or a forget reply is truthful.
 */
import { serve } from '@hono/node-server';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { configPath } from '../packages/runtime/config.ts';
import { RuntimeStore } from '../packages/runtime/store.ts';
import { RuntimeHost } from '../packages/runtime/host.ts';
import { createDshEngine } from '../packages/engines/dsh.ts';
import { createRuntimeApp } from '../apps/runtime/app.ts';
import { identitySettingKey } from '../packages/runtime/identity.ts';
import type { RuntimeConfig } from '../packages/runtime/config.ts';

const NAME_A = 'L1North7741';
const NAME_B = 'L1South2288';
const FACT_A = '验收代号是 L1FACT7741';
const FACT_B = '验收代号是 L1FACT2288';

interface Step { name: string; ok: boolean; detail: string }
const report: {
  script: string; liveModel: boolean; liveWebResearch: false; exitMeaning: string; manualReviewRequired: string[];
  modelId?: string; steps: Step[]; error?: string;
} = {
  script: 'verify-l1-live-model',
  liveModel: false,
  liveWebResearch: false,
  exitMeaning: 'Exit 0 means every automatic structural and state assertion passed. It does not certify model wording.',
  manualReviewRequired: [
    'capability-response-recorded only checks that the turn completed with a non-empty answer. Whether that answer invents email or Computer access must be reviewed by a person.',
    'Forget replies are not scored for wording. Whether the assistant honestly matches the tool result must be reviewed by a person.',
  ],
  steps: [],
};

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  return out.replace(/(?:sk-|tvly-)[A-Za-z0-9_-]{16,}/g, '[redacted]').slice(0, 800);
}

function finish(code: number, secrets: string[]): never {
  if (report.error) report.error = scrub(report.error, secrets);
  report.steps = report.steps.map(step => ({ ...step, detail: scrub(step.detail, secrets) }));
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function readModel(): { baseURL: string; id: string; apiKey: string } | null {
  const file = existsSync(configPath()) ? configPath() : '';
  const raw = file ? JSON.parse(readFileSync(file, 'utf8')) as { model?: { baseURL?: string; id?: string; apiKey?: string } } : {};
  const baseURL = process.env.KLEIO_MODEL_BASE_URL || raw.model?.baseURL || '';
  const id = process.env.KLEIO_MODEL_ID || raw.model?.id || '';
  const apiKey = process.env.KLEIO_MODEL_API_KEY || raw.model?.apiKey || '';
  if (!baseURL || !id || !apiKey) return null;
  return { baseURL, id, apiKey };
}

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm-live-model')) {
    report.error = 'Pass --confirm-live-model to call the configured model. This script is not a unit test.';
    finish(2, []);
  }
  const dsh = fileURLToPath(new URL('../packages/harness-dsh/.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url));
  if (!existsSync(dsh)) {
    report.error = 'Pinned DSH runtime is not installed. Live model check was not run.';
    finish(2, []);
  }
  const configuredModel = readModel();
  const model = configuredModel ? { ...configuredModel, contextWindow: 131072, maxTokens: 8192 } : undefined;
  if (!model) {
    report.error = 'Private model configuration has no usable endpoint. Live model check was not run.';
    finish(2, []);
  }
  const secrets = [model.apiKey];
  report.liveModel = true;
  report.modelId = model.id;
  const root = mkdtempSync(join(tmpdir(), 'kleio-l1-live-'));
  chmodSync(root, 0o700);
  const dataDirectory = join(root, 'data');
  mkdirSync(dataDirectory, { mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  secrets.push(token);
  let host: RuntimeHost | undefined;
  let store: RuntimeStore | undefined;
  let server: ReturnType<typeof serve> | undefined;
  try {
    const port = await freePort();
    const config: RuntimeConfig = {
      port, listenHost: '127.0.0.1', token, dataDirectory, model, memoryIdleMs: 86_400_000, search: { apiKey: '' },
    };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ port, dataDirectory, model: { baseURL: model.baseURL, id: model.id } }) + '\n', { mode: 0o600 });
    store = new RuntimeStore(join(dataDirectory, 'l1.sqlite'));
    chmodSync(join(dataDirectory, 'l1.sqlite'), 0o600);
    host = new RuntimeHost(store, createDshEngine({ dataDirectory: join(dataDirectory, 'engines/dsh'), model, promptTimeoutMs: 90_000 }), config);
    const app = createRuntimeApp(host, () => {});
    await new Promise<void>((resolve, reject) => {
      server = serve({ hostname: '127.0.0.1', port, fetch: request => app.fetch(request) }, () => resolve());
      server.once('error', reject);
    });
    host.start();
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
      const text = await response.text();
      const value = text ? JSON.parse(text) as unknown : null;
      return { status: response.status, value };
    };
    const claims = () => store!.db.prepare('SELECT id, status, record FROM km_claims').all() as Array<{ id: string; status: string; record: string }>;

    const posted = await api('/api/agent/identity', { method: 'POST', body: JSON.stringify({ name: NAME_A, tone: 'concise', avatar: 'sand', showChatUpdates: false }) });
    const identityFile = readFileSync(join(dataDirectory, 'standing/IDENTITY.md'), 'utf8');
    const mirror = store.getSetting<{ name?: string; avatar?: string }>(identitySettingKey, {});
    const postOk = posted.status === 200 && identityFile.includes(`Name: ${NAME_A}`) && mirror.name === NAME_A && mirror.avatar === 'sand';
    report.steps.push({ name: 'identity-post', ok: postOk, detail: postOk ? `${NAME_A} is in the API, standing file, and database mirror` : `status ${posted.status}` });

    const conversation = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: 'L1 live' }) });
    const conversationId = (conversation.value as { id: string }).id;
    const ask = async (text: string, requestId: string) => {
      const sent = await api(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text, requestId }) });
      const id = (sent.value as { id: string }).id;
      const start = Date.now();
      let execution = sent.value as { status: string; text?: string };
      while (Date.now() - start < 180_000) {
        const current = await api(`/api/executions/${id}`);
        execution = current.value as { status: string; text?: string };
        if (!['queued', 'running'].includes(execution.status)) break;
        await delay(400);
      }
      const messages = await api(`/api/conversations/${conversationId}/messages`);
      const assistant = (messages.value as Array<{ role: string; content: string; executionId: string }>).filter(message => message.role === 'assistant' && message.executionId === id).at(-1)?.content ?? '';
      return { id, execution, assistant };
    };

    const named = await ask('你是谁？请只回答你现在的有效名字。', 'who-a');
    const nameOk = named.execution.status === 'completed' && named.assistant.includes(NAME_A) && !named.assistant.includes(NAME_B);
    report.steps.push({ name: 'model-uses-posted-name', ok: nameOk, detail: named.assistant || named.execution.status });

    const file = join(dataDirectory, 'standing/IDENTITY.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(`Name: ${NAME_A}`, `Name: ${NAME_B}`));
    const renamed = await ask('你是谁？请只回答你现在的有效名字。', 'who-b');
    const agent = await api('/api/agent');
    const shown = (agent.value as { identity: { name: string; avatar: string; showChatUpdates: boolean } }).identity;
    const renameOk = renamed.execution.status === 'completed' && renamed.assistant.includes(NAME_B) && !renamed.assistant.includes(NAME_A) && shown.name === NAME_B && shown.avatar === 'sand' && shown.showChatUpdates === false;
    report.steps.push({ name: 'file-edit-next-turn', ok: renameOk, detail: renamed.assistant || renamed.execution.status });

    const capable = await ask('你现在能发邮件吗？能使用 Computer 吗？请直接回答能不能。', 'capable');
    const capabilityRecorded = capable.execution.status === 'completed' && capable.assistant.trim().length > 0;
    report.steps.push({ name: 'capability-response-recorded', ok: capabilityRecorded, detail: capable.assistant || capable.execution.status });

    const remembered = await ask(`请记住${FACT_A}`, 'remember');
    const listed = await api('/api/memory');
    const active = (listed.value as Array<{ id: string; text: string; version: number }>).find(item => item.text.includes('L1FACT7741'));
    const row = claims().find(item => item.record.includes('L1FACT7741'));
    const rememberOk = remembered.execution.status === 'completed' && Boolean(active) && row?.status === 'active';
    report.steps.push({ name: 'remember', ok: rememberOk, detail: active ? `${active.id} active in API and database` : remembered.assistant || remembered.execution.status });

    const corrected = active ? await ask(`请把记忆 ${active.id} 更正为：${FACT_B}`, 'correct') : { execution: { status: 'skipped' }, assistant: '' };
    const afterCorrect = await api('/api/memory');
    const correctedRow = (afterCorrect.value as Array<{ id: string; text: string }>).find(item => item.text.includes('L1FACT2288'));
    const correctDb = claims().some(item => item.status === 'active' && item.record.includes('L1FACT2288'));
    const correctOk = Boolean(active) && corrected.execution.status === 'completed' && Boolean(correctedRow) && correctDb;
    report.steps.push({ name: 'correct', ok: correctOk, detail: correctedRow ? `${correctedRow.id} replaced the synthetic fact` : corrected.assistant || corrected.execution.status });

    const disabled = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ memoryEnabled: false }) });
    const status = await api('/api/status');
    const memoryOff = (status.value as { memory: { enabled: boolean } }).memory.enabled === false;
    const settingOff = store.getSetting<boolean>('memoryEnabled', true) === false;
    const forgetId = correctedRow?.id ?? active?.id ?? '';
    const forgotten = forgetId ? await ask(`请忘掉记忆 ${forgetId}。这是明确的遗忘请求。`, 'forget-known') : { execution: { status: 'skipped' }, assistant: '' };
    const explained = forgetId ? await api(`/api/memory/${forgetId}/explain`) : { status: 0, value: null };
    const explanation = explained.value as { stopped?: boolean; usage?: string } | null;
    const forgottenDb = claims().find(item => item.id === forgetId);
    const knownOk = disabled.status === 200 && memoryOff && settingOff && forgotten.execution.status === 'completed' && explanation?.stopped === true && forgottenDb?.status === 'forgotten';
    report.steps.push({ name: 'forget-known-id-while-recall-disabled', ok: knownOk, detail: explanation?.usage ?? (forgotten.assistant || forgotten.execution.status) });

    const unknown = await ask('请忘掉记忆 missing-l1-id。', 'forget-unknown');
    const unknownEvents = await api(`/api/events?executionId=${encodeURIComponent(unknown.id)}`);
    const eventRows = Array.isArray(unknownEvents.value) ? unknownEvents.value as Array<{ type: string; data: { name?: string; code?: string; message?: string } }> : [];
    const toolFailed = eventRows.filter(event => event.type === 'tool.failed' && event.data?.name === 'memory_forget');
    const unknownDb = claims().some(item => item.id === 'missing-l1-id');
    const failureNote = toolFailed.map(event => [event.data.code, event.data.message].filter(Boolean).join(' ')).join('; ');
    const unknownOk = unknown.execution.status === 'completed' && toolFailed.length > 0 && unknown.assistant.trim().length > 0 && !unknownDb;
    report.steps.push({ name: 'forget-unknown-id-does-not-claim-success', ok: unknownOk, detail: [unknown.assistant, failureNote].filter(Boolean).join(' | ') || unknown.execution.status });
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'live check failed';
  } finally {
    await host?.close().catch(() => {});
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
  const ok = report.steps.length > 0 && report.steps.every(step => step.ok) && !report.error;
  finish(ok ? 0 : 1, secrets);
}

await main();
