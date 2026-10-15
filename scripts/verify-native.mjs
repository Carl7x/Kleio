/** Verify native dependencies and the application-owned memory without a model call. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepSeekMessagesBase } from './native-launch-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
for (const [name, folder, version] of [
  ['DeepSeek Harness', 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai/dsh', '0.2.1-alpha.2'],
]) {
  assert.equal(JSON.parse(readFileSync(resolve(root, folder, 'package.json'), 'utf8')).version, version);
  checks.push({ check: 'pinned dependency', name, version, passed: true });
}
for (const file of ['scripts/native-web.mjs', 'scripts/native-stop.mjs', 'scripts/native-launch-utils.mjs', 'scripts/verify-native.mjs', 'packages/personal-memory/store.mjs', 'packages/personal-memory/controller.mjs', 'packages/personal-memory/capture.mjs', 'packages/personal-agent/plugin.mjs', 'packages/personal-agent/http.mjs', 'packages/personal-agent/artifacts.mjs', 'packages/personal-tasks/store.mjs', 'packages/personal-tasks/adapter.mjs', 'packages/personal-agent-ui/host.mjs']) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  checks.push({ check: 'JavaScript syntax', file, passed: true });
}
for (const [input, output] of [
  ['https://api.deepseek.com', 'https://api.deepseek.com/anthropic'],
  ['https://api.deepseek.com/v1', 'https://api.deepseek.com/anthropic'],
  ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic'],
  ['https://example.com/messages/v1', 'https://example.com/messages/v1'],
]) assert.equal(deepSeekMessagesBase(input), output);
assert.throws(() => deepSeekMessagesBase('https://example.com/?key=not-a-credential'));
checks.push({ check: 'Messages API endpoint normalization', cases: 5, passed: true });
for (const file of ['config/personal-agent.patch.yml', 'config/assistant.md']) assert.ok(existsSync(resolve(root, file)), file);
if (!process.argv.includes('--quick')) {
  const files = ['packages/personal-memory/store.test.mjs', 'packages/personal-memory/files.test.mjs', 'packages/personal-memory/application.test.mjs', 'packages/personal-memory/capture.test.mjs', 'packages/personal-agent/source.test.mjs', 'packages/personal-agent/http.test.mjs', 'packages/personal-agent/artifacts.test.mjs', 'packages/personal-agent-ui/api.test.mjs', 'scripts/verify-personal-tasks.mjs'];
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const tests = Number(result.stdout.match(/# tests (\d+)/u)?.[1]);
  assert.ok(Number.isSafeInteger(tests) && tests > 0, 'Missing test-runner count');
  checks.push({ check: 'memory, profile, capture, task persistence, authenticated application routes, artifact catalog and UI client', tests, files, passed: true });
  process.stdout.write(result.stdout);
}
const report = { verifiedAt: new Date().toISOString(), modelRequests: 0, syntaxIsNotTypeChecking: true, checks };
mkdirSync(resolve(root, 'docs/personal-agent-v0.4-evidence'), { recursive: true });
writeFileSync(resolve(root, 'docs/personal-agent-v0.4-evidence/launcher-checks.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Native verification passed (${checks.length} checks; no model requests).`);
