import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_SCOPE_ID, type StandingContextPart } from '../context-contracts/context.ts';
import { compileProductContext, type CompileInput } from './compile.ts';
import { StandingStore } from './standing-store.ts';

const FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'AGENTS.md'] as const;

function writeStanding(directory: string, input: { name: string; tone: 'warm' | 'concise' | 'thoughtful'; marker: string }): void {
  mkdirSync(join(directory, 'standing'), { recursive: true });
  writeFileSync(join(directory, 'standing/IDENTITY.md'), `# Identity\n\n- Name: ${input.name}\n- Tone: ${input.tone}\n\n## Notes\n\n${input.marker} IDENTITY.md\n`);
  for (const file of FILES) {
    if (file === 'IDENTITY.md') continue;
    writeFileSync(join(directory, 'standing', file), `# ${file.slice(0, -3)}\n\n## Notes\n\n${input.marker} ${file}\n`);
  }
}

function baseInput(directory: string): CompileInput {
  return {
    dataDirectory: directory,
    now: '2026-10-19T00:00:00.000Z',
    timezone: 'Etc/UTC',
    memoryEnabled: true,
    kind: 'conversation',
    prompt: '请忘掉那条记忆',
    toolNames: ['memory_forget', 'memory_search', 'memory_explain'],
    searchConfigured: false,
  };
}

describe('G3.4 compile standing part', { concurrency: false }, () => {
  test('a captured part matches the legacy loader and stays fixed after edits and removal', t => {
    const directory = mkdtempSync(join(tmpdir(), 'kleio-compile-standing-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeStanding(directory, { name: '旧显示名', tone: 'concise', marker: 'G3OLD' });
    const store = new StandingStore({ dataDirectory: directory, scopeId: LOCAL_SCOPE_ID });
    const part = store.capture({ scopeId: LOCAL_SCOPE_ID, executionId: 'compile-exec', conversationId: 'compile-conv' });
    const base = baseInput(directory);
    const fromPart = compileProductContext({ ...base, standing: part });
    const fromDisk = compileProductContext(base);
    assert.equal(fromPart, fromDisk);
    assert.match(fromPart, /"id":"forget"/);
    assert.equal(fromPart.includes("Kleio playbook forget"), false);
    assert.match(fromPart, /Skill catalog \(metadata only\)/);
    assert.equal(fromPart.includes(part.content.snapshotId), false);
    assert.equal(fromPart.includes(part.content.sourceVersion), false);
    assert.equal(fromPart.includes(directory), false);
    for (const file of FILES) assert.match(fromPart, new RegExp(`G3OLD ${file.replace('.', '\\.')}`));

    const originalRead = StandingStore.prototype.read;
    let reads = 0;
    t.mock.method(StandingStore.prototype, 'read', function (this: StandingStore) {
      reads += 1;
      return originalRead.call(this);
    });
    writeStanding(directory, { name: '新显示名', tone: 'thoughtful', marker: 'G3NEW' });
    const afterEdit = compileProductContext({ ...base, standing: part });
    assert.equal(afterEdit, fromPart);
    assert.equal(reads, 0);
    assert.equal(part.content.name, '旧显示名');
    assert.equal(part.content.files.every(file => file.text.includes('G3OLD') && !file.text.includes('G3NEW')), true);
    const reread = compileProductContext(base);
    assert.match(reread, /Effective display name: 新显示名/);
    assert.equal(reread.includes('G3OLD'), false);
    assert.equal(reads, 1);

    rmSync(join(directory, 'standing'), { recursive: true, force: true });
    const afterRemoval = compileProductContext({ ...base, standing: part });
    assert.equal(afterRemoval, fromPart);
    assert.equal(reads, 1);
    assert.equal(existsSync(join(directory, 'standing')), false);
    assert.equal(Object.isFrozen(part), true);
    assert.equal(Object.isFrozen(part.content), true);
    assert.equal(Object.isFrozen(part.content.files[0]), true);
    assert.throws(() => { (part.content as { name: string }).name = 'mutated'; });
    assert.equal(part.content.name, '旧显示名');
  });

  test('redact applies to the effective name and every standing body without changing the snapshot', t => {
    const directory = mkdtempSync(join(tmpdir(), 'kleio-compile-redact-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const sentinel = 'G3遗忘哨兵甲';
    writeStanding(directory, { name: sentinel, tone: 'warm', marker: sentinel });
    const part = new StandingStore({ dataDirectory: directory, scopeId: LOCAL_SCOPE_ID }).capture({ scopeId: LOCAL_SCOPE_ID, executionId: 'redact-exec' });
    const originalRead = StandingStore.prototype.read;
    let reads = 0;
    t.mock.method(StandingStore.prototype, 'read', function (this: StandingStore) {
      reads += 1;
      return originalRead.call(this);
    });
    const redact = (text: string) => text.replaceAll(sentinel, '[已停止使用]');
    const input: CompileInput = { ...baseInput(directory), redact, standing: part };
    const compiled = compileProductContext(input);
    assert.equal(reads, 0);
    assert.equal(compiled.includes(sentinel), false);
    assert.match(compiled, /Effective display name: \[已停止使用\]/);
    for (const file of FILES) assert.match(compiled, new RegExp(`\\[已停止使用\\] ${file.replace('.', '\\.')}`));
    assert.equal(compiled.includes(part.id), false);
    assert.equal(compiled.includes(part.content.sourceVersion), false);
    assert.equal(compiled.includes(directory), false);
    assert.equal(part.content.name, sentinel);
    assert.equal(part.content.files.every(file => file.text.includes(sentinel)), true);
    const legacy = compileProductContext({ ...baseInput(directory), redact });
    assert.equal(legacy.includes(sentinel), false);
    assert.match(legacy, /Effective display name: \[已停止使用\]/);
    assert.equal(reads, 1);
    rmSync(join(directory, 'standing'), { recursive: true, force: true });
    const again = compileProductContext(input);
    assert.equal(again, compiled);
    assert.equal(reads, 1);
    assert.equal(part.content.name, sentinel);
    const held: StandingContextPart = part;
    assert.equal(Object.isFrozen(held.content.problems), true);
  });
});
