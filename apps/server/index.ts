import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentEngine } from '../../packages/core/contracts.ts';
import { AgentStore } from '../../packages/core/store.ts';
import { AgentService, DemoEngine } from '../../packages/core/service.ts';
import { acquireOwnership } from '../../packages/core/ownership.ts';
import { DshEngine } from './dsh-engine.ts';
import { UnconfiguredEngine } from './unconfigured-engine.ts';
import { inspectDshSetup, prepareDshLaunch } from '../../packages/harness-dsh/src/setup.ts';
import { createApp } from './app.ts';

const mode = process.env.AGENT_ENGINE ?? 'demo';
if (!['demo', 'dsh'].includes(mode)) throw new Error('AGENT_ENGINE must be demo or dsh');
const baseDir = fileURLToPath(new URL('../../', import.meta.url));
const workspace = resolve(baseDir, process.env.DSH_WORKSPACE ?? '.data/workspace');
const port = Number(process.env.AGENT_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AGENT_PORT must be an integer from 1024 to 65535');
const trustedWebOrigin = process.env.AGENT_WEB_ORIGIN;
if (trustedWebOrigin) {
  const origin = new URL(trustedWebOrigin);
  if (origin.origin !== trustedWebOrigin || origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname))
    throw new Error('AGENT_WEB_ORIGIN must be an exact local HTTP origin');
}

let engine: AgentEngine | undefined;
let store: AgentStore | undefined;
let service: AgentService | undefined;
let server: ReturnType<typeof serve> | undefined;
let closing: Promise<void> | undefined;
let settleStartup!: () => void;
const startupSettled = new Promise<void>(settled => { settleStartup = settled; });
const ownership = await acquireOwnership(resolve(baseDir, process.env.AGENT_DATABASE ?? '.data/personal-agent.sqlite'), error => {
  console.error(error.message); process.exitCode = 1;
  void close().catch(() => { process.exitCode = 1; });
});

function close(): Promise<void> {
  closing ??= (async () => {
    // Keep ownership until in-flight configuration writes reach a quiet point.
    await startupSettled;
    const serverStopped = server ? new Promise<void>(resolveStopped => server!.close(() => resolveStopped())) : Promise.resolve();
    let shutdownError: unknown;
    try { await service?.close(); }
    catch (error) { shutdownError = error; }
    // Even a stale run's settlement error must not leave the old engine running.
    try { await engine?.close(); }
    catch (error) {
      // Keep ownership and the database open if engine shutdown is unconfirmed.
      throw shutdownError ?? error;
    }
    await serverStopped;
    try { store?.close(); }
    finally { await ownership.release(); }
    if (shutdownError) throw shutdownError;
  })();
  return closing;
}
process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });

function assertStarting(): void {
  if (closing) throw new Error('服务已停止，启动流程已取消。');
  ownership.assertHeld();
}

try {
  assertStarting();
  const inspection = await inspectDshSetup(process.env, { baseDir });
  assertStarting();
  const missing = inspection.checks.filter(check => check.status === 'missing').map(check => check.message);
  if (mode === 'dsh' && inspection.status === 'ready') {
    mkdirSync(workspace, { recursive: true });
    const launch = await prepareDshLaunch(process.env, { baseDir });
    assertStarting();
    engine = new DshEngine(launch, workspace);
  } else engine = mode === 'dsh' ? new UnconfiguredEngine(missing) : new DemoEngine();
  store = new AgentStore(ownership.databasePath);
  // Recovery belongs to this lock owner, not to whichever process starts first.
  service = new AgentService(store, engine);
  const webRoot = resolve(baseDir, 'apps/web/dist');
  const app = createApp(service, { ...(existsSync(resolve(webRoot, 'index.html')) ? { webRoot } : {}),
    ...(trustedWebOrigin ? { trustedWebOrigin } : {}),
    runtime: { status: mode === 'demo' ? 'demo' : inspection.status, missing,
      note: mode === 'demo' ? '当前为固定输出的演示模式。接入模型后才能使用真实助理能力。' :
        inspection.status === 'ready' ? '配置已齐备；首次任务会连接模型，认证和执行结果需要实际验证。' : '模型接入配置尚未齐备，请查看下列说明。' },
  });
  server = serve({ fetch: request => {
    if (closing) return new Response('服务正在停止。', { status: 503 });
    ownership.assertHeld(); return app.fetch(request);
  }, hostname: '127.0.0.1', port }, () => console.log(`Personal Agent 内核服务：http://127.0.0.1:${port} · Kleio · ${engine!.id}`));
  server.once('error', error => {
    console.error('本机服务启动或运行失败：' + error.message); process.exitCode = 1;
    void close().catch(() => { process.exitCode = 1; });
  });
} catch (error) {
  settleStartup();
  await close(); throw error;
} finally {
  settleStartup();
}
