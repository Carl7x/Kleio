import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export interface RuntimeConfig {
  port: number;
  token: string;
  dataDirectory: string;
  model: { baseURL: string; id: string; apiKey: string };
  memoryIdleMs: number;
}
export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export function configPath(): string { return resolve(process.env.KLEIO_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'kleio/config.json')); }
export function outsideRepository(path: string): void {
  let parent = resolve(path); const tail: string[] = [];
  while (!existsSync(parent)) { tail.unshift(basename(parent)); parent = dirname(parent); }
  const rel = relative(realpathSync(repositoryRoot), join(realpathSync(parent), ...tail));
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Private configuration and runtime data must be outside the source repository.');
}
export function loadConfig(): RuntimeConfig {
  const file = configPath(); outsideRepository(file);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<RuntimeConfig> : {};
  const port = Number(process.env.KLEIO_PORT ?? raw.port ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('KLEIO_PORT must be between 1024 and 65535.');
  const dataDirectory = resolve(process.env.KLEIO_DATA_DIR ?? raw.dataDirectory ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'kleio'));
  outsideRepository(dataDirectory);
  const config: RuntimeConfig = { port, dataDirectory,
    token: process.env.KLEIO_TOKEN ?? raw.token ?? randomBytes(32).toString('base64url'),
    model: { baseURL: process.env.KLEIO_MODEL_BASE_URL ?? raw.model?.baseURL ?? 'https://api.deepseek.com', id: process.env.KLEIO_MODEL_ID ?? raw.model?.id ?? 'deepseek-flash', apiKey: process.env.KLEIO_MODEL_API_KEY ?? raw.model?.apiKey ?? '' },
    memoryIdleMs: Number(process.env.KLEIO_MEMORY_IDLE_MS ?? raw.memoryIdleMs ?? 120_000),
  };
  if (!Number.isFinite(config.memoryIdleMs) || config.memoryIdleMs < 1_000) throw new Error('Memory idle delay must be at least 1000 ms.');
  if (config.token.length < 24) throw new Error('The local API token must contain at least 24 characters.');
  const endpoint = new URL(config.model.baseURL);
  if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname))) throw new Error('Model endpoint must use HTTPS or loopback HTTP.');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); chmodSync(dirname(file), 0o700);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ port, token: config.token, dataDirectory, model: { baseURL: config.model.baseURL, id: config.model.id } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 }); chmodSync(dataDirectory, 0o700);
  return config;
}
