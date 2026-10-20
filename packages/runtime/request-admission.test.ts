/** Product request-admission policy. No engine, network, or provider text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequestAdmission, RequestAdmissionConfigError, RequestAdmissionProtocolError,
  type DenialReceipt, type RequestAdmission,
} from './request-admission.ts';

const RECEIPT_KEYS = ['executionId', 'scopeId', 'hostGeneration', 'policyEpoch', 'requestSequence', 'code', 'estimatedInputTokens', 'contextLimit', 'outputLimit', 'safetyMarginTokens'] as const;

function host(epoch = { value: 3 }, profile?: { version: string; contextLimit: number; outputLimit: number; safetyMarginTokens: number }) {
  const frozen = profile ?? { version: 'profile-a', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 5 };
  return createRequestAdmission({
    executionId: 'exec-1', scopeId: 'scope-1', hostGeneration: 4, policyEpoch: 3,
    profile: frozen, readPolicyEpoch: () => epoch.value,
  });
}

function check(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionId: 'exec-1', hostGeneration: 4, requestSequence: 1, policyEpoch: 3, profileVersion: 'profile-a',
    contextLimit: 100, outputLimit: 20, estimatedInputTokens: 10, estimatorId: 'dsh-token-meter/estimate@0.2.1-alpha.2',
    retainedResourceReceipts: [], ...over,
  };
}

function allow(admission: RequestAdmission, over: Record<string, unknown> = {}) {
  const decision = admission.check(check(over));
  assert.equal(decision.kind, 'allow');
  if (decision.kind !== 'allow') throw new Error('expected allow');
  return decision.admission;
}

function deny(admission: RequestAdmission, over: Record<string, unknown> = {}): DenialReceipt {
  const decision = admission.check(check(over));
  assert.equal(decision.kind, 'deny');
  if (decision.kind !== 'deny') throw new Error('expected deny');
  assert.deepEqual(Object.keys(decision.receipt).sort(), [...RECEIPT_KEYS].sort());
  assert.equal(JSON.stringify(decision.receipt).includes('SYNTHETIC'), false);
  return decision.receipt;
}

test('admits an in-policy request and freezes the host binding', () => {
  const profile = { version: 'profile-a', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 5, note: 'SYNTHETIC_PROFILE_SECRET' };
  const epoch = { value: 3 };
  const admission = createRequestAdmission({
    executionId: 'exec-1', scopeId: '范围-1', hostGeneration: 4, policyEpoch: 3, profile, readPolicyEpoch: () => epoch.value,
  });
  profile.contextLimit = 1; profile.safetyMarginTokens = 0; epoch.value = 3;
  assert.deepEqual(admission.binding, { executionId: 'exec-1', scopeId: '范围-1', hostGeneration: 4, policyEpoch: 3 });
  assert.deepEqual(admission.profile, { version: 'profile-a', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 5 });
  assert.equal(Object.isFrozen(admission.binding), true);
  assert.equal(Object.isFrozen(admission.profile), true);
  assert.equal(JSON.stringify(admission.profile).includes('SYNTHETIC_PROFILE_SECRET'), false);
  const admitted = allow(admission);
  assert.deepEqual(admitted, { requestSequence: 1, policyEpoch: 3, hostGeneration: 4 });
  assert.equal(admission.denialReceipt(), undefined);
  assert.deepEqual(allow(admission, { requestSequence: 2 }), { requestSequence: 2, policyEpoch: 3, hostGeneration: 4 });
});

test('exact capacity boundary counts input, output reserve, and host margin', () => {
  const admission = host();
  assert.equal(allow(admission, { estimatedInputTokens: 75 }).requestSequence, 1);
  const second = host();
  const receipt = deny(second, { estimatedInputTokens: 76 });
  assert.equal(receipt.code, 'CONTEXT_BUDGET_EXCEEDED');
  assert.equal(receipt.estimatedInputTokens, 76);
  assert.equal(receipt.safetyMarginTokens, 5);
  assert.equal(receipt.policyEpoch, 3);
  const edge = host(undefined, { version: 'profile-a', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 0 });
  assert.equal(allow(edge, { estimatedInputTokens: 80, outputLimit: 20 }).requestSequence, 1);
  const over = host(undefined, { version: 'profile-a', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 0 });
  assert.equal(deny(over, { estimatedInputTokens: 81 }).code, 'CONTEXT_BUDGET_EXCEEDED');
});

test('first-request overflow denies and then never allows', () => {
  const admission = host();
  const receipt = deny(admission, { estimatedInputTokens: 90 });
  assert.equal(receipt.requestSequence, 1);
  const again = admission.check(check({ requestSequence: 2, estimatedInputTokens: 0 }));
  assert.equal(again.kind, 'deny');
  if (again.kind === 'deny') assert.equal(again.receipt, receipt);
  assert.equal(admission.check({ not: 'a check' }).kind, 'deny');
});

test('replay, gaps, and foreign bindings are protocol errors and do not terminate', () => {
  const admission = host();
  assert.throws(() => admission.check(check({ requestSequence: 2 })), RequestAdmissionProtocolError);
  assert.equal(allow(admission).requestSequence, 1);
  assert.throws(() => admission.check(check({ requestSequence: 1 })), RequestAdmissionProtocolError);
  assert.throws(() => admission.check(check({ requestSequence: 3 })), RequestAdmissionProtocolError);
  assert.equal(admission.denialReceipt(), undefined);
  assert.equal(allow(admission, { requestSequence: 2 }).requestSequence, 2);
});

test('wrong execution, generation, profile, or capacity is not a budget decision', () => {
  for (const over of [
    { executionId: 'exec-2' }, { hostGeneration: 5 }, { profileVersion: 'profile-b' },
    { contextLimit: 1_000_000 }, { contextLimit: 99 }, { outputLimit: 19 }, { outputLimit: 21 },
    { safetyMarginTokens: 0 }, { scopeId: 'scope-2' }, { prompt: 'SYNTHETIC_PROMPT_SECRET' },
  ]) {
    const admission = host();
    assert.throws(() => admission.check(check(over)), RequestAdmissionProtocolError);
    assert.equal(admission.denialReceipt(), undefined);
    assert.equal(admission.binding.scopeId, 'scope-1');
    assert.equal(allow(admission).requestSequence, 1);
  }
});

test('a stale bound epoch is revocation and a forged epoch is a protocol error', () => {
  const epoch = { value: 3 };
  const revoked = host(epoch);
  allow(revoked);
  epoch.value = 5;
  const receipt = deny(revoked, { requestSequence: 2 });
  assert.equal(receipt.code, 'CONTEXT_INVALIDATED');
  assert.equal(receipt.policyEpoch, 5);
  assert.equal(receipt.requestSequence, 2);
  assert.equal(revoked.check(check({ requestSequence: 3, estimatedInputTokens: 0 })).kind, 'deny');

  const forgedCurrent = host({ value: 5 });
  assert.throws(() => forgedCurrent.check(check({ policyEpoch: 5 })), RequestAdmissionProtocolError);
  assert.equal(forgedCurrent.denialReceipt(), undefined);
  assert.equal(deny(forgedCurrent).code, 'CONTEXT_INVALIDATED');

  const forgedRequest = host();
  assert.throws(() => forgedRequest.check(check({ policyEpoch: 9 })), RequestAdmissionProtocolError);
  assert.equal(forgedRequest.denialReceipt(), undefined);
  assert.equal(allow(forgedRequest).requestSequence, 1);
});

test('illegal numbers, unknown receipts, and bad estimator ids fail closed', () => {
  const badValues = [1.5, Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1, '1'];
  for (const estimatedInputTokens of badValues) {
    const admission = host();
    assert.throws(() => admission.check(check({ estimatedInputTokens })), RequestAdmissionProtocolError);
    assert.equal(admission.denialReceipt(), undefined);
  }
  const receipts = host();
  assert.throws(() => receipts.check(check({ retainedResourceReceipts: [{ id: 'page-1' }] })), RequestAdmissionProtocolError);
  assert.equal(receipts.denialReceipt(), undefined);
  assert.equal(allow(receipts).requestSequence, 1);
  for (const estimatorId of ['', ' bad', 'has space', 'x'.repeat(82), '中文', 'ok\n']) {
    assert.throws(() => host().check(check({ estimatorId })), RequestAdmissionProtocolError);
  }
  assert.equal(allow(host(), { estimatorId: 'dsh-token-meter/estimate@0.2.1-alpha.2' }).requestSequence, 1);
});

test('malformed checks and unconfirmable policy reads do not become budget denials', () => {
  for (const input of [null, [], 'check', 1, { ...check(), extra: true }, (() => { const value = check(); delete value.executionId; return value; })()]) {
    const admission = host();
    assert.throws(() => admission.check(input), RequestAdmissionProtocolError);
    assert.equal(admission.denialReceipt(), undefined);
  }
  let calls = 0;
  const failing = createRequestAdmission({
    executionId: 'exec-1', scopeId: 'scope-1', hostGeneration: 4, policyEpoch: 3,
    profile: { version: 'profile-a', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 5 },
    readPolicyEpoch: () => { calls += 1; throw new Error('SYNTHETIC_POLICY_SECRET'); },
  });
  assert.throws(() => failing.check(check()), (error: unknown) => error instanceof RequestAdmissionProtocolError && error.message === 'Request check was rejected.' && !error.message.includes('SYNTHETIC_POLICY_SECRET'));
  assert.equal(failing.denialReceipt(), undefined);
  assert.throws(() => failing.check(check()), RequestAdmissionProtocolError);
  assert.equal(calls, 1);
  const reentrant = createRequestAdmission({
    executionId: 'exec-1', scopeId: 'scope-1', hostGeneration: 4, policyEpoch: 3,
    profile: { version: 'profile-a', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 5 },
    readPolicyEpoch: () => { reentrant.check(check({ requestSequence: 2 })); return 3; },
  });
  assert.throws(() => reentrant.check(check()), RequestAdmissionProtocolError);
  assert.equal(reentrant.denialReceipt(), undefined);
  assert.throws(() => reentrant.check(check()), RequestAdmissionProtocolError);
});

test('incomplete host configuration is rejected before any check exists', () => {
  const profile = { version: 'profile-a', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 5 };
  const base = { executionId: 'exec-1', scopeId: 'scope-1', hostGeneration: 4, policyEpoch: 3, profile, readPolicyEpoch: () => 3 };
  for (const input of [
    { ...base, executionId: '' }, { ...base, executionId: 'bad\nid' }, { ...base, scopeId: '' },
    { ...base, hostGeneration: -1 }, { ...base, hostGeneration: 1.2 }, { ...base, policyEpoch: -1 },
    { ...base, profile: { ...profile, version: '' } }, { ...base, profile: { ...profile, version: 'v'.repeat(65) } },
    { ...base, profile: { ...profile, contextLimit: 0 } }, { ...base, profile: { ...profile, outputLimit: 100 } },
    { ...base, profile: { ...profile, outputLimit: 101 } }, { ...base, profile: { ...profile, safetyMarginTokens: -1 } },
    { ...base, readPolicyEpoch: undefined },
  ]) {
    assert.throws(() => createRequestAdmission(input as never), RequestAdmissionConfigError);
  }
  assert.equal(new RequestAdmissionConfigError().message.includes('profile-a'), false);
});
