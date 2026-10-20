import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';

test('old config loads without invented model capacity; explicit env capacity is validated and preserved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-capacity-config-'));
  const keys = ['KLEIO_CONFIG', 'KLEIO_DATA_DIR', 'KLEIO_TOKEN', 'KLEIO_MODEL_CONTEXT_WINDOW', 'KLEIO_MODEL_MAX_TOKENS'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify({ token: 'synthetic-config-token-12345', dataDirectory: join(directory, 'data'), model: { baseURL: 'https://example.invalid', id: 'unknown-provider' } }));
    process.env.KLEIO_CONFIG = configPath; process.env.KLEIO_DATA_DIR = join(directory, 'data'); process.env.KLEIO_TOKEN = 'synthetic-config-token-12345';
    delete process.env.KLEIO_MODEL_CONTEXT_WINDOW; delete process.env.KLEIO_MODEL_MAX_TOKENS;
    const legacy = loadConfig();
    assert.equal(legacy.model.contextWindow, undefined); assert.equal(legacy.model.maxTokens, undefined);
    process.env.KLEIO_MODEL_CONTEXT_WINDOW = '131072'; process.env.KLEIO_MODEL_MAX_TOKENS = '8192';
    assert.equal(loadConfig().model.contextWindow, 131072); assert.equal(loadConfig().model.maxTokens, 8192);
    process.env.KLEIO_MODEL_CONTEXT_WINDOW = 'NaN'; assert.throws(() => loadConfig(), /positive integer/);
    process.env.KLEIO_MODEL_CONTEXT_WINDOW = '8000'; assert.throws(() => loadConfig(), /below contextWindow/);
  } finally { for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(directory, { recursive: true, force: true }); }
});
