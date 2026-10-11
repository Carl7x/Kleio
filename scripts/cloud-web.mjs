/** Open an authenticated cloud Harness through a local SSH forward. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openNativeBrowser } from './native-launch-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.some(flag => !['--no-open', '--public'].includes(flag))) throw new Error('Only --no-open and --public are supported.');
const sshHost = process.env.KLEIO_CLOUD_SSH_HOST || 'kleio-cloud';
const localPort = Number(process.env.KLEIO_CLOUD_LOCAL_PORT || 4318);
const remotePort = Number(process.env.KLEIO_CLOUD_REMOTE_PORT || 4317);
const statePath = process.env.KLEIO_CLOUD_STATE_PATH || '/opt/kleio/.data/native-web.json';
if (!/^[A-Za-z0-9_.@-]+$/u.test(sshHost) || !/^\/[A-Za-z0-9_./-]+$/u.test(statePath)) throw new Error('Invalid cloud connection configuration.');
for (const port of [localPort, remotePort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid cloud port.');
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10'];
const read = spawnSync('ssh', [...sshOptions, sshHost, `cat -- '${statePath}'`], { encoding: 'utf8', timeout: 20000, windowsHide: true });
if (read.error || read.status !== 0) throw new Error('无法读取云端服务状态，请检查 SSH 配置及 Kleio 服务。');
let nativeState;
try { nativeState = JSON.parse(read.stdout); } catch { throw new Error('云端服务状态格式无效。'); }
const launch = new URL(nativeState.launchUrl);
const nativeRoot = new URL(nativeState.url);
if (launch.origin !== nativeRoot.origin || launch.pathname !== '/' || launch.username || launch.password || !/^[A-Za-z0-9_-]+$/u.test(launch.searchParams.get('token') || '')) throw new Error('云端服务认证入口无效。');
if (flags.includes('--public')) {
  if (launch.protocol !== 'https:') throw new Error('云端尚未配置 HTTPS 公网入口。');
  if (!flags.includes('--no-open')) {
    const bin = resolve(root, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
    if (!existsSync(bin)) throw new Error('本机浏览器启动依赖缺失，请先运行 pnpm setup:native。');
    await openNativeBrowser(bin, launch.href);
  }
  console.log(`Kleio 公网入口：${nativeRoot.href}`);
  process.exit(0);
}
const recordPath = resolve(root, '.data/remote-tunnel.json');
const portOpen = () => new Promise(resolveOpen => {
  const socket = createConnection({ host: '127.0.0.1', port: localPort });
  let settled = false;
  const finish = value => { if (settled) return; settled = true; socket.destroy(); resolveOpen(value); };
  socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  socket.setTimeout(1000, () => finish(false));
});
if (await portOpen()) {
  let existing;
  try { existing = JSON.parse(readFileSync(recordPath, 'utf8')); process.kill(existing.pid, 0); } catch { throw new Error('本机云端入口端口被其他进程占用。'); }
  if (existing.sshHost !== sshHost || existing.localPort !== localPort || existing.remotePort !== remotePort) throw new Error('本机端口未绑定到当前云端连接。');
} else {
  const child = spawn('ssh', [...sshOptions, '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', sshHost], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  child.unref();
  let connected = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await portOpen()) { connected = true; break; }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  if (!connected) throw new Error('SSH 隧道未能建立，请检查连接。');
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify({ pid: child.pid, sshHost, localPort, remotePort, startedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}
launch.protocol = 'http:';
launch.hostname = '127.0.0.1';
launch.port = String(localPort);
if (!flags.includes('--no-open')) {
  const bin = resolve(root, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (!existsSync(bin)) throw new Error('本机浏览器启动依赖缺失，请先运行 pnpm setup:native。');
  await openNativeBrowser(bin, launch.href);
}
console.log(`Kleio 云端入口：http://127.0.0.1:${localPort}/`);
