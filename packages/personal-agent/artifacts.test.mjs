import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactCatalog } from './artifacts.mjs';

test('cross-conversation results survive reopening and native event replay is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-result-index-'));
  let catalog;
  try {
    const path = join(directory, 'application.sqlite');
    catalog = new ArtifactCatalog(path);
    const saved = catalog.remember({ sessionId: 'a', path: '/workspace/report.md', taskId: 'task-a', sha256: 'revision-a' }, 'native-event-a');
    assert.equal(catalog.remember({ sessionId: 'a', path: '/workspace/report.md' }, 'native-event-a').id, saved.id);
    catalog.close(); catalog = new ArtifactCatalog(path);
    assert.equal(catalog.list({ taskId: 'task-a' })[0].sha256, 'revision-a');
  } finally { catalog?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('latest presentations replace a file listing while different conversation results remain distinct', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-result-revisions-'));
  const catalog = new ArtifactCatalog(join(directory, 'application.sqlite'));
  try {
    catalog.remember({ sessionId: 'a', path: '/report.md', taskId: 'task-a', sha256: 'old' }, 'a:1');
    catalog.remember({ sessionId: 'b', path: '/report.md', taskId: null, sha256: 'other-session' }, 'b:1');
    catalog.remember({ sessionId: 'a', path: '/report.md', taskId: 'task-a', sha256: 'new' }, 'a:2');
    assert.deepEqual(catalog.list().map(record => record.sha256), ['new', 'other-session']);
    assert.equal(catalog.list({ taskId: 'task-a' }).length, 1);
    assert.throws(() => catalog.list({ limit: 1000 }));
  } finally { catalog.close(); rmSync(directory, { recursive: true, force: true }); }
});
