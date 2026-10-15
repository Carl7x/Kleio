import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = process.env.KLEIO_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'kleio/config.json');
const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const executable = process.env.KLEIO_NODE_BINARY ?? config.nodeExecutable ?? process.execPath;
const [command = 'start', ...args] = process.argv.slice(2);
const entry = command === 'start' ? 'apps/runtime/index.ts' : ['web', 'mobile'].includes(command) ? 'apps/cli/web.ts' : 'apps/cli/index.ts';
const childArgs = command === 'mobile' ? ['--lan', ...args] : ['start', 'web'].includes(command) ? args : [command, ...args];
const child = spawn(executable, ['--import', 'tsx', entry, ...childArgs], { cwd: root, stdio: 'inherit', shell: false, env: command === 'mobile' ? { ...process.env, KLEIO_LISTEN_HOST: '0.0.0.0' } : process.env });
child.once('error', () => { console.error('Could not start Kleio. Configure a compatible Node executable.'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
