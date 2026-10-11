/** Local-only dsh setup checks and an explicit, private subprocess launch plan. */
import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DshAcpOptions } from './index.ts';

/** Checks expose readiness explanations, never credentials or raw configuration. */
export interface DshSetupCheck {
  id: 'runtime' | 'arguments' | 'home' | 'workspace' | 'model' | 'credential';
  status: 'ready' | 'missing';
  message: string;
}

/** `ready` means required local configuration exists, not provider authentication. */
export interface DshSetupStatus {
  status: 'ready' | 'missing';
  checks: DshSetupCheck[];
}

/** Paths are resolved from the product directory, independently of a UI's cwd. */
export interface DshSetupOptions { baseDir: string }

/** Errors contain fixed, user-facing explanations rather than secret values. */
export class DshSetupError extends Error {
  readonly code = 'DSH_SETUP_MISSING';
  constructor(readonly checks: DshSetupCheck[]) {
    super(checks.filter(check => check.status === 'missing').map(check => check.message).join(' '));
    this.name = 'DshSetupError';
  }
}

interface ResolvedSetup {
  command: string;
  args: string[];
  home: string;
  workspace: string;
  model: { baseURL: string; id: string; credentialEnv: string; contextWindow: number; maxTokens: number };
}

const profileOverlay = fileURLToPath(new URL('../profiles/kleio-acp.patch.yml', import.meta.url));
const hostEnvironment = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PATHEXT', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'] as const;

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

async function executable(command: string, env: NodeJS.ProcessEnv, baseDir: string): Promise<string | undefined> {
  const hasPath = isAbsolute(command) || command.includes('/') || command.includes('\\');
  const candidates = hasPath ? [resolve(baseDir, command)] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, command));
  for (const candidate of candidates) {
    const expanded = process.platform === 'win32' && !extname(candidate) ? [candidate, `${candidate}.exe`, `${candidate}.com`] : [candidate];
    for (const path of expanded) {
      // Windows batch launchers require a shell; ACP deliberately never uses one.
      if (process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(path).toLowerCase())) continue;
      try { await access(path, constants.X_OK); if (await fileExists(path)) return path; }
      catch { /* Try another PATH candidate without printing launch configuration. */ }
    }
  }
  return undefined;
}

async function usableDirectory(path: string): Promise<boolean> {
  let candidate = path;
  for (;;) {
    try {
      if (!(await stat(candidate)).isDirectory()) return false;
      await access(candidate, constants.R_OK | constants.W_OK);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

function launcherArguments(raw: string | undefined): string[] | undefined {
  let value: unknown;
  try { value = raw === undefined ? [] : JSON.parse(raw); }
  catch { return undefined; }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && !item.includes('\0'))) return undefined;
  const args: string[] = [];
  let prefixCount = 0;
  for (let index = 0; index < value.length; index++) {
    const argument: string = value[index]!;
    if (argument === '--profile') {
      const profile = value[++index];
      if (profile !== 'acp' && profile !== 'kleio') return undefined;
    } else if (argument === '--from-default-profile') {
      if (value[++index] !== 'acp') return undefined;
    } else if (argument === '--patch') {
      const patch = value[++index];
      if (typeof patch !== 'string' || !patch || patch.startsWith('-')) return undefined;
      args.push(argument, patch);
    } else if (argument.startsWith('-') || argument === 'plugin' || argument === 'acp' || argument === 'kleio') return undefined;
    else {
      if (++prefixCount > 1 || args.length > 0 || !argument) return undefined;
      args.push(argument);
    }
  }
  return args;
}

function positiveInteger(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function resolveSetup(env: NodeJS.ProcessEnv, options: DshSetupOptions): Promise<{ status: DshSetupStatus; resolved?: ResolvedSetup }> {
  const baseDir = resolve(options.baseDir);
  const localCli = resolve(baseDir, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const defaultRuntime = !env.DSH_COMMAND && await fileExists(localCli);
  const command = defaultRuntime ? process.execPath : await executable(env.DSH_COMMAND?.trim() ?? '', env, baseDir);
  const parsedArgs = launcherArguments(env.DSH_ARGS_JSON);
  let args = parsedArgs;
  if (args && defaultRuntime && (!args[0] || args[0].startsWith('-'))) args = [localCli, ...args];
  if (args) {
    args = [...args];
    for (let index = 0; index < args.length; index++) {
      if (index === 0 && !args[index]!.startsWith('-')) args[index] = resolve(baseDir, args[index]!);
      else if (args[index] === '--patch') {
        index++;
        args[index] = resolve(baseDir, args[index]!);
      }
    }
    const paths = args.filter((argument, index) => (index === 0 && !argument.startsWith('-')) || args?.[index - 1] === '--patch');
    if (!(await Promise.all(paths.map(fileExists))).every(Boolean)) args = undefined;
    if (command && /^node(?:\.exe)?$/i.test(basename(command)) && (!args?.[0] || args[0].startsWith('-'))) args = undefined;
    if (!await fileExists(profileOverlay)) args = undefined;
  }
  const home = resolve(baseDir, env.DSH_HOME?.trim() || '.data/dsh');
  const workspace = resolve(baseDir, env.DSH_WORKSPACE?.trim() || '.data/workspace');
  const baseURL = env.KLEIO_MODEL_BASE_URL?.trim() ?? '';
  const id = env.KLEIO_MODEL_ID?.trim() ?? '';
  const credentialEnv = env.KLEIO_MODEL_API_KEY_ENV?.trim() || 'KLEIO_MODEL_API_KEY';
  const contextWindow = positiveInteger(env.KLEIO_MODEL_CONTEXT_WINDOW, 32768);
  const maxTokens = positiveInteger(env.KLEIO_MODEL_MAX_TOKENS, 4096);
  let validURL = false;
  try {
    const url = new URL(baseURL);
    validURL = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { /* Missing or invalid endpoints remain setup states; no network call. */ }
  const validModel = validURL && !!id && !/[\r\n\0]/.test(id) && contextWindow !== undefined && maxTokens !== undefined && maxTokens <= contextWindow;
  const reservedCredentialNames: readonly string[] = [...hostEnvironment, 'DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED'];
  const credentialPresent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv) && !reservedCredentialNames.includes(credentialEnv) && !!env[credentialEnv]?.trim();
  const [homeUsable, workspaceUsable] = await Promise.all([usableDirectory(home), usableDirectory(workspace)]);
  const checks: DshSetupCheck[] = [
    { id: 'runtime', status: command ? 'ready' : 'missing', message: command ? 'dsh 启动程序已找到；版本兼容性将在 ACP 初始化时确认。' : '请安装 dsh，或设置 DSH_COMMAND；Windows 请使用 node.exe 与 dsh 的 bin.js 路径。' },
    { id: 'arguments', status: args ? 'ready' : 'missing', message: args ? 'ACP 启动参数可用。' : 'DSH_ARGS_JSON 必须是启动文件与可选 ACP profile/patch 参数组成的字符串数组。' },
    { id: 'home', status: homeUsable ? 'ready' : 'missing', message: homeUsable ? 'dsh 独立数据目录可用；显式 DSH_HOME 可复用指定目录。' : 'DSH_HOME 必须指向可创建或可写的本地目录。' },
    { id: 'workspace', status: workspaceUsable ? 'ready' : 'missing', message: workspaceUsable ? 'Agent 工作目录可用。' : 'DSH_WORKSPACE 必须指向可创建或可写的本地目录。' },
    { id: 'model', status: validModel ? 'ready' : 'missing', message: validModel ? '模型路由已配置；尚未请求模型或验证账号。' : '请设置 KLEIO_MODEL_BASE_URL 和 KLEIO_MODEL_ID；模型容量须为正整数，输出上限不可大于上下文窗口。模型地址不可包含凭据或查询参数。' },
    { id: 'credential', status: credentialPresent ? 'ready' : 'missing', message: credentialPresent ? '指定模型凭据环境变量已设置；尚未验证有效性。' : '请在本机环境或被忽略的 .env 中设置模型 key；默认变量为 KLEIO_MODEL_API_KEY，可用 KLEIO_MODEL_API_KEY_ENV 指定其他变量名。' },
  ];
  const status: DshSetupStatus = { status: checks.every(check => check.status === 'ready') ? 'ready' : 'missing', checks };
  if (status.status === 'missing' || !command || !args || contextWindow === undefined || maxTokens === undefined) return { status };
  return { status, resolved: { command, args, home, workspace, model: { baseURL, id, credentialEnv, contextWindow, maxTokens } } };
}

/** Inspect local prerequisites without writing files, launching dsh, or contacting a provider. */
export async function inspectDshSetup(env: NodeJS.ProcessEnv, options: DshSetupOptions): Promise<DshSetupStatus> {
  return (await resolveSetup(env, options)).status;
}

/**
 * Prepare a private dsh launch plan. Its env contains a selected credential and
 * must only be passed to the subprocess, never serialized to API responses/logs.
 */
export async function prepareDshLaunch(env: NodeJS.ProcessEnv, options: DshSetupOptions): Promise<DshAcpOptions & { cwd: string; env: NodeJS.ProcessEnv; args: string[] }> {
  const setup = await resolveSetup(env, options);
  if (!setup.resolved) throw new DshSetupError(setup.status.checks);
  const { command, args, home, workspace, model } = setup.resolved;
  const generated = join(home, 'kleio-model.patch.json');
  const initializeProfile = !await fileExists(join(home, 'profiles/kleio/package.json'));
  await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })]);
  // JSON is valid YAML. No !!js evaluation or literal key is emitted.
  const overlay = [
    { id: 'llm-pi-ai', config: { providers: { 'kleio-model': { apiKeyEnv: model.credentialEnv, api: 'openai-completions', baseURL: model.baseURL, retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoningEfforts: false }] } } } },
    { id: 'acp', config: { provider: 'kleio-model', model: model.id } },
    { id: 'agent-default-model', config: { provider: 'kleio-model', model: model.id } },
  ];
  await writeFile(generated, `${JSON.stringify(overlay, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of hostEnvironment) if (env[key] !== undefined) childEnv[key] = env[key];
  Object.assign(childEnv, { DSH_HOME: home, DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_DISABLED: '1', [model.credentialEnv]: env[model.credentialEnv] });
  return { command, args: [...args, '--profile', 'kleio', ...(initializeProfile ? ['--from-default-profile', 'acp'] : []), '--patch', profileOverlay, '--patch', generated], cwd: workspace, env: childEnv };
}
