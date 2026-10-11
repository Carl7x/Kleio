import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'docs/kleio-v0.1-evidence');
mkdirSync(evidence, { recursive: true });
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '.runtime', 'public'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const testFiles = ['packages/core/test', 'packages/harness-dsh/test'].flatMap(directory =>
  files(join(root, directory)).filter(path => path.endsWith('.test.ts')));
const checks = [
  ['core-types', root, ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['web-types', join(root, 'apps/web'), ['../../node_modules/typescript/bin/tsc', '--noEmit']],
  ['tests', root, ['--import', 'tsx', '--test', ...testFiles]],
  ['web-build', root, ['apps/web/node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts']],
];
const results = [];
for (const [name, cwd, args] of checks) {
  const start = Date.now();
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(evidence, `${name}.txt`), output);
  results.push({ name, exitCode: result.status, signal: result.signal, durationMs: Date.now() - start,
    ...(result.error ? { error: result.error.message } : {}),
    ...(name === 'tests' ? { summary: output.split('\n').filter(line => /^ℹ (tests|pass|fail|cancelled|skipped|todo) /.test(line)) } : {}) });
  console.log(`${name}: ${result.status === 0 ? 'passed' : 'FAILED'}`);
}
const sources = ['packages/core', 'packages/harness-dsh', 'apps/server', 'apps/web/src'].flatMap(directory => files(join(root, directory)));
for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/vite.config.ts', 'scripts/dev.mjs', 'scripts/verify-kleio.mjs', 'scripts/smoke-dsh-conversation.ts']) sources.push(join(root, path));
const verification = { verifiedAt: new Date().toISOString(), node: process.version,
  scope: 'Kleio v0.1 core, ACP adapter, local server and production web build. No paid provider or external account action.',
  checks: results, sourceHashes: Object.fromEntries(sources.map(path => [relative(root, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')])) };
writeFileSync(join(evidence, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
process.exitCode = results.every(result => result.exitCode === 0) ? 0 : 1;
