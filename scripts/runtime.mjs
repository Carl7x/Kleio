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
const entry = command === 'start' ? 'apps/runtime/index.ts' : 'apps/cli/index.ts';
const child = spawn(executable, ['--import', 'tsx', entry, ...(command === 'start' ? args : [command, ...args])], { cwd: root, stdio: 'inherit', shell: false, env: process.env });
child.once('error', () => { console.error('Could not start Kleio. Configure a compatible Node executable.'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
