/** Launch the published DeepSeek Harness Web profile with its original UI. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { delimiter, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';
import lockfile from 'proper-lockfile';
import { deepSeekMessagesBase, openNativeBrowser } from './native-launch-utils.mjs';
import { MemoryStore } from '../packages/personal-memory/store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.some(flag => flag !== '--no-open')) throw new Error('Only --no-open is supported. Set KLEIO_PORT to change the local port.');
process.chdir(root);
if (existsSync(resolve(root, '.env'))) loadEnvFile(resolve(root, '.env'));
const runtime = resolve(root, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai');
const bin = resolve(runtime, 'dsh/lib/bin.js');
if (!existsSync(bin)) throw new Error('DeepSeek Harness is missing. Run pnpm setup:dsh first.');
for (const file of ['packages/personal-agent/plugin.mjs', 'packages/personal-memory/store.mjs', 'packages/personal-agent-ui/host.mjs', 'packages/personal-agent-ui/dist/client.js', 'config/assistant.md', 'config/personal-agent.patch.yml']) {
  if (!existsSync(resolve(root, file))) throw new Error(`The application extension is missing: ${file}`);
}

const dshHome = resolve(process.env.KLEIO_DSH_HOME || resolve(root, '.data/dsh-native'));
const workspace = resolve(process.env.KLEIO_WORKSPACE || resolve(root, '.data/personal-workspace'));
const port = Number(process.env.KLEIO_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('KLEIO_PORT must be an integer from 1 to 65535.');
// The external HTTPS proxy owns exposure; the Harness and lifecycle endpoint stay on loopback.
let publicUrl;
if (process.env.KLEIO_PUBLIC_URL) {
  try { publicUrl = new URL(process.env.KLEIO_PUBLIC_URL); } catch { throw new Error('KLEIO_PUBLIC_URL must be a valid HTTPS root.'); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('KLEIO_PUBLIC_URL must be an HTTPS origin root without credentials.');
}
mkdirSync(dshHome, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(resolve(root, '.data'), { recursive: true });
const statePath = resolve(root, '.data/native-web.json');
const lockPath = resolve(root, '.data/native-web-instance');
let release;
try {
  release = await lockfile.lock(lockPath, { realpath: false, stale: 30_000, update: 5_000, retries: 0 });
} catch (error) {
  if (error.code !== 'ELOCKED') throw error;
  let existing;
  try { existing = JSON.parse(readFileSync(statePath, 'utf8')); } catch { throw new Error('Kleio is already starting. Wait for its browser window.'); }
  const response = await fetch(`http://127.0.0.1:${existing.controlPort}/status`, { headers: { authorization: `Bearer ${existing.controlToken}` }, signal: AbortSignal.timeout(2_000) });
  if (!response.ok || existing.dshHome !== dshHome) throw new Error('Another Kleio instance is active. Stop it before changing its data directory.');
  console.log(`Kleio is already running: ${existing.url}`);
  if (!process.argv.includes('--no-open')) await openNativeBrowser(bin, existing.launchUrl);
  process.exit(0);
}
let releaseHome;
try {
  releaseHome = await lockfile.lock(dshHome, { lockfilePath: resolve(dshHome, '.kleio.lock'), stale: 30_000, update: 5_000, retries: 0 });
} catch (error) {
  await release();
  if (error.code === 'ELOCKED') throw new Error('This Harness data directory is already in use by another Kleio launch.');
  throw error;
}

// Only credential references enter the profile; the key remains in the inherited environment.
if (process.env.KLEIO_MODEL_API_KEY) process.env.DEEPSEEK_API_KEY = process.env.KLEIO_MODEL_API_KEY;
process.env.DSH_HOME = dshHome;
process.env.KLEIO_PROJECT_ROOT = root;
process.env.DSH_TELEMETRY_MODE = 'DISABLED';
process.env.DEEPSEEK_BASE_URL = deepSeekMessagesBase(process.env.KLEIO_MODEL_BASE_URL || 'https://api.deepseek.com');
// Keep a personal workspace from inheriting a Git repository rooted at the user's entire home.
// This changes only this application's child-process environment, never global Git configuration.
const gitCeilings = (process.env.GIT_CEILING_DIRECTORIES || '').split(delimiter).filter(Boolean);
if (!gitCeilings.some(directory => resolve(directory).toLowerCase() === homedir().toLowerCase())) gitCeilings.push(homedir());
process.env.GIT_CEILING_DIRECTORIES = gitCeilings.join(delimiter);

// Seed the editable profile layer so the original settings forms can update it later.
const preferences = resolve(dshHome, 'profiles/web/cordis.patch.yml');
if (!existsSync(preferences)) {
  mkdirSync(dirname(preferences), { recursive: true });
  const standard = readFileSync(resolve(runtime, 'dsh-web-app/presets/standard.patch.yml'), 'utf8').replace(/\r\n/g, '\n');
  const start = standard.indexOf('- insert:\n');
  if (start < 0) throw new Error('The installed Web preset format is unsupported.');
  const preset = standard.slice(start).replace('- insert:\n', '').split('\n').map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n')
    .replace('prefix: You are a coding agent powered by the {{model}} model.', 'prefix: 你是 Kleio，一位个人助理。');
  const seed = [
    '- id: locale\n  config:\n    preference: zh',
    `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${JSON.stringify(process.env.KLEIO_MODEL_ID || 'deepseek-flash')}`,
    '- id: session-log-deepseek\n  disabled: true',
    '- id: directory-picker\n  disabled: true',
    "- insert:\n    - id: directory-picker-browse\n      name: '@deepseek-ai/dsh-host-directory-picker-browse'\n    - id: ui-directory-picker-browse\n      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    preset,
  ].join('\n');
  writeFileSync(preferences, seed + '\n', { flag: 'wx', mode: 0o600 });
}

// Replace only the exact earlier default persona; preserve user-authored presets.
const oldDefaultPersona = 'prefix: >-\n            你是 Kleio，一位个人助理。默认用简洁中文回答，先完成用户交代的事情。\n            用户明确要求记住信息时调用记忆工具保存，回答相关历史问题前先检索记忆，\n            用户要求更正或忘记时使用对应工具更新或删除。不要把测试样例当成用户真实资料，不保存密钥。';
const editableProfile = readFileSync(preferences, 'utf8').replace(/\r\n/g, '\n');
// Upgrade only the old shipped identity. User-authored names and instructions are retained.
const previousBrandPrefix = 'prefix: 你是 Kinloom，一位个人助理。';
if (editableProfile.includes(previousBrandPrefix)) writeFileSync(preferences, editableProfile.replace(previousBrandPrefix, 'prefix: 你是 Kleio，一位个人助理。'), { mode: 0o600 });
if (editableProfile.includes(oldDefaultPersona)) {
  const backupPath = `${preferences}.before-personal-agent`;
  if (!existsSync(backupPath)) writeFileSync(backupPath, editableProfile, { flag: 'wx', mode: 0o600 });
  writeFileSync(preferences, editableProfile.replace(oldDefaultPersona, 'prefix: 你是 Kleio，一位个人助理。'), { mode: 0o600 });
}

// Import observations once into the application's service; keep the original file.
const legacyMemory = resolve(dshHome, 'memory.jsonl');
if (existsSync(legacyMemory)) {
  const original = readFileSync(legacyMemory, 'utf8');
  const ownedMemory = new MemoryStore(resolve(dshHome, process.env.KLEIO_STORAGE_SUBDIR || 'kleio', 'memory.sqlite'));
  try { ownedMemory.importReferenceGraph(original.split(/\r?\n/), `reference-jsonl:${createHash('sha256').update(original).digest('hex')}`); }
  finally { ownedMemory.close(); }
}

const controlToken = randomBytes(32).toString('hex');
let ready = false;
let requestedStop = false;
const stop = () => { requestedStop = true; if (ready) process.emit('SIGTERM'); };
const control = createServer((req, res) => {
  const received = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${controlToken}`);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/status') { res.writeHead(ready ? 200 : 503).end(); return; }
  if (req.method !== 'POST' || req.url !== '/stop') { res.writeHead(404).end(); return; }
  res.writeHead(202).end('stopping');
  stop();
});
await new Promise((resolveStarted, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolveStarted); });
const address = control.address();
if (!address || typeof address === 'string') throw new Error('The local shutdown endpoint did not start.');
const state = { pid: process.pid, port, url: publicUrl?.href || `http://127.0.0.1:${port}/`, controlPort: address.port, controlToken, dshHome, workspace, startedAt: new Date().toISOString(), launchUrl: '' };
process.once('exit', () => {
  if (!existsSync(statePath)) return;
  try { if (JSON.parse(readFileSync(statePath, 'utf8')).pid === process.pid) unlinkSync(statePath); } catch { /* An unreadable state is left for inspection. */ }
});
process.once('SIGTERM', () => control.close());
process.once('SIGINT', () => control.close());

const personalAgentPatch = resolve(root, 'config/personal-agent.patch.yml');
const pluginPath = resolve(root, 'packages/personal-agent/plugin.mjs').replaceAll('\\', '/').replaceAll("'", "''");
const uiPluginPath = resolve(root, 'packages/personal-agent-ui/host.mjs').replaceAll('\\', '/').replaceAll("'", "''");
const resolvedPatch = resolve(root, '.data/native-personal-agent.patch.yml');
const patchText = readFileSync(personalAgentPatch, 'utf8');
if (!patchText.includes('__KLEIO_PERSONAL_AGENT_PLUGIN__')) throw new Error('The application patch is missing its plugin-path placeholder.');
writeFileSync(resolvedPatch, patchText.replaceAll('__KLEIO_PERSONAL_AGENT_PLUGIN__', pluginPath).replaceAll('__KLEIO_PERSONAL_AGENT_UI_PLUGIN__', uiPluginPath), { mode: 0o600 });
process.argv = [process.execPath, bin, '--profile', 'web', '--patch', resolvedPatch, '--host', '127.0.0.1', '--port', String(port), ...(publicUrl ? ['--public-url', publicUrl.href, '--trusted-host', publicUrl.host] : []), ...flags];
process.chdir(workspace);
const write = process.stdout.write;
let output = '';
process.stdout.write = function (chunk, ...args) {
  output = (output + chunk.toString()).slice(-4096);
  const match = output.match(/dsh web: (https?:\/\/[^\s]+\/\?token=[A-Za-z0-9_-]+)/);
  if (match) {
    const announced = new URL(match[1]);
    if (announced.origin === new URL(state.url).origin) state.launchUrl = announced.href;
  }
  return write.call(this, chunk, ...args);
};
try {
  const { runCli } = await import(pathToFileURL(bin).href);
  await runCli();
  const applicationPlugin = await import(pathToFileURL(resolve(root, 'packages/personal-agent/plugin.mjs')).href);
  if (!applicationPlugin.isPersonalAgentReady()) {
    process.emit('SIGTERM');
    throw new Error('The personal-agent extension did not become ready. Refusing to deliver a bare Harness fallback.');
  }
  process.stdout.write = write;
  if (!state.launchUrl) throw new Error('The native application did not announce a ready URL.');
  ready = true;
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, statePath);
  if (requestedStop) process.emit('SIGTERM');
} catch (error) {
  process.stdout.write = write;
  control.close();
  await releaseHome();
  await release();
  throw error;
}
