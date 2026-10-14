import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { acquireOwnership } from '../../packages/core/ownership.ts';
import { loadConfig } from '../../packages/runtime/config.ts';
import { RuntimeStore } from '../../packages/runtime/store.ts';
import { RuntimeHost } from '../../packages/runtime/host.ts';
import { createDshEngine } from '../../packages/engines/dsh.ts';
import { createRuntimeApp } from './app.ts';

process.umask(0o077);
const config = loadConfig();
let host: RuntimeHost | undefined;
let store: RuntimeStore | undefined;
let server: ReturnType<typeof serve> | undefined;
let closing: Promise<void> | undefined;
const ownership = await acquireOwnership(join(config.dataDirectory, 'kleio.sqlite'), () => { void close(); });
async function close(): Promise<void> {
  closing ??= (async () => {
    const stopped = server ? new Promise<void>(resolve => server!.close(() => resolve())) : Promise.resolve();
    await host?.close();
    if (server && 'closeAllConnections' in server) server.closeAllConnections(); await stopped;
    store?.close(); await ownership.release();
  })();
  return closing;
}
const stop = () => { void close().catch(() => { console.error('Kleio could not confirm shutdown.'); process.exitCode = 1; }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const engine = createDshEngine({ dataDirectory: join(config.dataDirectory, 'engines/dsh'), model: config.model });
  store = new RuntimeStore(ownership.databasePath); chmodSync(ownership.databasePath, 0o600);
  host = new RuntimeHost(store, engine, config);
  const app = createRuntimeApp(host, stop);
  server = serve({ fetch: request => {
    if (closing) return new Response('Stopping', { status: 503 });
    ownership.assertHeld(); return app.fetch(request);
  }, hostname: '127.0.0.1', port: config.port }, () => {
    console.log(`Kleio runtime: http://127.0.0.1:${config.port} (local authentication enabled)`);
    console.log('Connect with pnpm chat. Closing the client leaves this service running.');
    if (!config.model.apiKey) console.log('Model credentials are missing. Configure the private model settings before chatting.');
    host!.start();
  });
  server.once('error', () => { console.error('Kleio could not bind the local service port.'); process.exitCode = 1; stop(); });
} catch (error) {
  await close();
  console.error(error instanceof Error ? error.message.replaceAll(config.model.apiKey || '\0', '[redacted]') : 'Kleio startup failed'); process.exitCode = 1;
}
