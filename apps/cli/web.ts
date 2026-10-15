import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, repositoryRoot } from '../../packages/runtime/config.ts';

const config = loadConfig();
const base = `http://127.0.0.1:${config.port}`;
const flags = process.argv.slice(2);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: repositoryRoot, stdio: 'inherit' });
    child.once('error', () => reject(new Error('Could not build the Web client. Install workspace dependencies first.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The Web build did not finish.')));
  });
}
async function probe(): Promise<boolean> {
  let response: Response;
  try { response = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) }); }
  catch { return false; }
  const data = await response.json().catch(() => null) as { product?: string; ok?: boolean } | null;
  if (!response.ok || !data?.ok || data.product !== 'Kleio') throw new Error('The local port is occupied by another service.');
  return true;
}
async function main(): Promise<void> {
  if (flags.some(flag => !['--no-open', '--skip-build', '--lan'].includes(flag))) throw new Error('Supported options: --no-open, --skip-build, --lan');
  if (!flags.includes('--skip-build')) {
    console.log('Building Kleio Web…');
    await run(join(repositoryRoot, 'node_modules/typescript/bin/tsc'), ['--noEmit', '-p', 'apps/mobile/tsconfig.json']);
    await run(join(repositoryRoot, 'apps/mobile/node_modules/expo/bin/cli'), ['export', 'apps/mobile', '--platform', 'web', '--output-dir', 'dist/web']);
  }
  if (!existsSync(join(repositoryRoot, 'apps/mobile/dist/web/index.html'))) throw new Error('Build the Web client with pnpm web first.');
  if (flags.includes('--lan') && await probe()) {
    const response = await fetch(base + '/api/status', { headers: { authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('The running service uses different configuration. Stop it before enabling device access.');
    const status = await response.json() as { deviceAccess?: boolean };
    if (!status.deviceAccess) {
      const active = await fetch(base + '/api/executions', { headers: { authorization: 'Bearer ' + config.token } }).then(r => r.json()) as Array<{ status: string }>;
      if (active.some(execution => ['running', 'queued'].includes(execution.status))) throw new Error('Work is in progress. Let it finish, then run pnpm mobile again to enable device access.');
      const stopped = await fetch(base + '/api/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + config.token } });
      if (!stopped.ok) throw new Error('Could not restart the local service for device access.');
      for (let attempt = 0; attempt < 80 && await probe(); attempt++) await wait(250);
      if (await probe()) throw new Error('The local service is still stopping. Retry shortly.');
    }
  }
  if (!await probe()) {
    const log = openSync(join(config.dataDirectory, 'runtime.log'), 'a', 0o600);
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/runtime/index.ts'], {
      cwd: repositoryRoot, detached: true, stdio: ['ignore', log, log], env: process.env,
    });
    let exited = false; let failed = false;
    child.once('exit', () => { exited = true; }); child.once('error', () => { failed = true; });
    closeSync(log); child.unref();
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (exited || failed) break;
      await wait(250);
      if (await probe()) { ready = true; break; }
    }
    if (!ready) { child.kill('SIGTERM'); throw new Error('Kleio could not start. Inspect runtime.log in the private data directory.'); }
  }
  const response = await fetch(base + '/api/session-tickets', {
    method: 'POST', headers: { authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('The running service needs to be restarted. Run pnpm stop, then pnpm web.');
  const ticket = await response.json() as { ticket: string; expiresAt: string };
  if (typeof ticket.ticket !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(ticket.ticket)) throw new Error('Invalid local launch response.');
  const url = base + '/#ticket=' + ticket.ticket;
  writeFileSync(join(config.dataDirectory, 'web-launch.json'), JSON.stringify({ url, expiresAt: ticket.expiresAt }) + '\n', { mode: 0o600 });
  if (!flags.includes('--no-open')) {
    const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const opener = spawn(program, args, { stdio: 'ignore', detached: true });
    opener.on('error', () => { console.error('The browser could not be opened. The one-time link is in the private web-launch.json file.'); });
    opener.unref();
  }
  console.log(`Kleio Web: ${base}/`);
  if (flags.includes('--lan')) console.log('Start the Expo native client with pnpm mobile:dev. Its server endpoint is supplied by the development or deployment configuration.');
  console.log('The service keeps running when the browser closes. Stop it with pnpm stop.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Could not open Kleio Web.'); process.exitCode = 1; });
