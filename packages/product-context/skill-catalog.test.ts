import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkill, parseSkillIndex } from './skill-catalog.ts';
test('standard YAML and legacy metadata; no body projection', () => {
  const parsed = parseSkill('---\nname: Friendly name\ndescription: >-\n  First line\n  second line\nmetadata:\n  kleio:\n    requiresTools: [web_search]\n    executionKinds: [research]\n---\nsecret body','fourth');
  assert.equal(parsed.description,'First line second line'); assert.equal(parsed.skillId,'fourth'); assert.ok(!JSON.stringify(parsed).includes('secret body'));
  assert.equal(parseSkill('---\nid: legacy\ndescription: old\n---\nbody','legacy').name,'legacy');
});
test('strict YAML rejects duplicate keys, aliases, tags and malformed permissions', () => {
  for (const yaml of ['name: a\nname: b\ndescription: x','name: &a thing\ndescription: *a','name: !!str thing\ndescription: x','name: !foo thing\ndescription: x','name: thing\ndescription: x\nmetadata:\n  kleio:\n    requiresTools: web_search','name: thing\ndescription: x\nallowed-tools: shell','name: thing\ndescription: x\nmetadata:\n  kleio:\n    permissions: shell']) assert.throws(() => parseSkill(`---\n${yaml}\n---\nbody`,'fourth'));
  assert.throws(() => parseSkillIndex('{"version":1,"skills":[{"id":"a"},{"id":"a"}]}'));
});
