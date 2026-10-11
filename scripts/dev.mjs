import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(new URL('../.env', import.meta.url))) process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const children = [];
let closing = false;
function launch(args, env = {}, graceful = false) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env },
    stdio: graceful ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', windowsHide: true });
  child.graceful = graceful;
  children.push(child);
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { if (!closing) stop(code ?? 1); });
}
function stop(code = 0) {
  if (closing) return; closing = true; process.exitCode = code;
  for (const child of children) if (child.exitCode === null) {
    if (child.graceful && child.connected) child.send('shutdown');
    else child.kill();
  }
}
// Remember requests that arrive before the server registers its signal handler.
const serverBootstrap = "let initialized = false, stopRequested = false; process.on('message', message => { if (message === 'shutdown') { stopRequested = true; if (initialized) process.emit('SIGTERM'); } }); await import('./apps/server/index.ts'); initialized = true; if (stopRequested) process.emit('SIGTERM'); process.channel?.unref();";
launch(['--env-file-if-exists=.env', '--import', 'tsx', '--input-type=module', '--eval', serverBootstrap], { AGENT_WEB_ORIGIN: 'http://127.0.0.1:5173' }, true);
launch(['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts'], { KLEIO_API_URL: 'http://127.0.0.1:' + (process.env.AGENT_PORT ?? '4317') });
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
