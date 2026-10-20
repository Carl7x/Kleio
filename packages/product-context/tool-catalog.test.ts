import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_TOOL_CATALOG, catalogAvailability } from './tool-catalog.ts';
import { loadProductSchemaValidator } from '../harness-dsh/src/headless.ts';

test('product schema vocabulary is accepted by the real pinned DSH validator', async () => {
  const validator = await loadProductSchemaValidator({ dataDirectory: '/unused-synthetic', model: { baseURL: 'http://127.0.0.1', id: 'synthetic', apiKey: 'synthetic' } });
  for (const tool of PRODUCT_TOOL_CATALOG) {
    assert.doesNotThrow(() => validator.assertSchema(tool.inputSchema), tool.name);
  }
});

test('published catalog definitions and nested metadata are immutable', () => {
  assert.ok(Object.isFrozen(PRODUCT_TOOL_CATALOG));
  for (const descriptor of PRODUCT_TOOL_CATALOG) {
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(Object.isFrozen(descriptor.profiles));
    assert.ok(Object.isFrozen(descriptor.capability));
    assert.ok(Object.isFrozen(descriptor.inputSchema.properties));
  }
});

test('reordering declarations preserves each descriptor qualification and configuration', () => {
  const reversed = [...PRODUCT_TOOL_CATALOG].reverse();
  const policy = { memoryEnabled: false, searchConfigured: false };
  const byName = (facts: ReturnType<typeof catalogAvailability>) => Object.fromEntries(facts.map(fact => [fact.name, fact]));
  for (const profile of ['conversation', 'research', 'legacy-research', 'review', 'memory'] as const) {
    assert.deepEqual(byName(catalogAvailability(reversed, profile, policy)), byName(catalogAvailability(PRODUCT_TOOL_CATALOG, profile, policy)));
  }
  const research = byName(catalogAvailability(reversed, 'research', policy));
  assert.equal(research.memory_search!.reason, 'memory-disabled');
  assert.equal(research.web_search!.available, true);
  assert.equal(research.web_search!.capability.configurationMode, 'keyless');
});
