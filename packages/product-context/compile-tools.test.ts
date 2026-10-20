import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileProductContext } from './compile.ts';
import { ensureSkills, KNOWN_TOOLS } from './skills.ts';
import { PRODUCT_TOOL_CATALOG } from './tool-catalog.ts';
import { ToolRegistry } from '../runtime/tool-registry.ts';

const registry = () => new ToolRegistry(PRODUCT_TOOL_CATALOG, PRODUCT_TOOL_CATALOG.map(tool => ({ name: tool.name, handler: async () => null })));

test('compiler uses snapshot tools and policy over contradictory legacy inputs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-compile-tools-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const effectiveTools = registry().capture({ scopeId: 'local', executionId: 'synthetic' }, 'conversation', { memoryEnabled: false, searchConfigured: false });
  const text = compileProductContext({ dataDirectory: directory, now: '2026-10-19T00:00:00Z', timezone: 'Etc/UTC', memoryEnabled: true, searchConfigured: true, kind: 'review', prompt: '请忘掉那个事实', toolNames: ['memory_search', 'shell'], effectiveTools });
  assert.match(text, /Execution kind: conversation/);
  assert.match(text, /memory_search: implemented=yes; configured=no; available=no/);
  assert.match(text, /Known-ID correction and forgetting stay available/);
  assert.match(text, /web_search: implemented=yes; configuration=keyless; available=yes/);
  assert.match(text, /Callable this turn/);
  assert.match(text, /shell: implemented=no/);
  assert.match(text, /"id":"forget"/);
  assert.equal(text.includes("Kleio playbook forget"), false);
});

test('legacy compilation intersects supplied names with directory profile and policy', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-compile-legacy-tools-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = { dataDirectory: directory, now: '2026-10-19T00:00:00Z', timezone: 'Etc/UTC', memoryEnabled: false, searchConfigured: false, prompt: '你能做什么', toolNames: [...KNOWN_TOOLS, 'shell'] };
  const text = compileProductContext({ ...base, kind: 'review' });
  assert.match(text, /web_search: implemented=yes; configuration=keyless; available=no/);
  assert.match(text, /create_work: implemented=yes; configured=yes; available=no/);
  assert.match(text, /Skill catalog \(metadata only\)/);
  assert.equal(text.includes("Kleio playbook"), false);
  assert.deepEqual(KNOWN_TOOLS, PRODUCT_TOOL_CATALOG.map(tool => tool.name));
});

test('skill requirements and bindings use snapshot names and registered names', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-compile-skill-tools-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  ensureSkills(directory);
  writeFileSync(join(directory, 'skills-index.json'), JSON.stringify({ version: 1, skills: [{ id: 'wide-research', enabled: true, requiresTools: ['create_work'], toolBindings: { search: 'web_search' } }] }));
  const effectiveTools = registry().capture({ scopeId: 'local', executionId: 'synthetic' }, 'conversation', { memoryEnabled: true, searchConfigured: false, disabledTools: ['create_work'] });
  const text = compileProductContext({ dataDirectory: directory, now: '2026-10-19T00:00:00Z', timezone: 'Etc/UTC', memoryEnabled: true, searchConfigured: false, kind: 'conversation', prompt: '帮我研究', toolNames: ['create_work'], effectiveTools });
  assert.equal(text.includes('"id":"wide-research"'), false);
  assert.match(text, /Skill catalog \(metadata only\)/);
  assert.equal(text.includes("Kleio playbook"), false);
});
