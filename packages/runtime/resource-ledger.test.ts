import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceLedger, resourcePageDigest } from './resource-ledger.ts';
import { createRequestAdmission, RequestAdmissionProtocolError } from './request-admission.ts';
const binding = { scopeId: 'scope', executionId: 'execution' };
const resource = { sourceRef: 'skill:test/SKILL.md', sourceVersion: 'v1', text: '中文🙂'.repeat(2000), metadata: { related: ['r'.repeat(9000)] } };
const make = (limit = 100000) => new ResourceLedger({ ...binding, inputLimitTokens: limit, initialOccupiedTokens: 100 });
test('whole resource reservation, metadata and unicode pages, repeat and scope guards', () => {
  const ledger = make();
  let page = ledger.read(resource, binding);
  assert.equal(page.kind, 'context-resource');
  if (page.kind !== 'context-resource') return;
  assert.equal(page.section, 'metadata');
  assert.ok(ledger.outstandingReservedTokens > 0);
  assert.equal(ledger.verifyRetained([]), false);
  const receipts = []; const text: string[] = []; const metadata: string[] = [];
  for (;;) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    assert.equal(page.text.includes('\ufffd'), false);
    receipts.push({ receiptId: page.receiptId, digest: resourcePageDigest(page) });
    (page.section === 'text' ? text : metadata).push(page.text);
    const currentCursor = page.nextCursor;
    assert.throws(() => ledger.read(resource, { ...binding, scopeId: 'other', cursor: currentCursor! }), /SCOPE/);
    if (!page.nextCursor) break;
    const next = ledger.read(resource, { ...binding, cursor: page.nextCursor });
    assert.equal(next.kind, 'context-resource');
    if (next.kind !== 'context-resource') return;
    page = next;
  }
  assert.equal(text.join(''), resource.text);
  assert.deepEqual(JSON.parse(metadata.join('')), resource.metadata);
  assert.equal(ledger.outstandingReservedTokens, 0);
  assert.equal(ledger.verifyRetained(receipts), true);
  assert.equal(ledger.verifyRetained(receipts.slice(1)), false);
  assert.equal(ledger.verifyRetained([{ ...receipts[0]!, digest: '0'.repeat(64) }, ...receipts.slice(1)]), false);
  assert.equal(ledger.read(resource, binding).kind, 'context-resource-reference');
  ledger.close(); assert.equal(ledger.outstandingReservedTokens, 0);
  assert.throws(() => ledger.read(resource, binding), /SCOPE/);
});
test('reservation failure is atomic and close releases outstanding pages', () => {
  const ledger = make(1000);
  assert.throws(() => ledger.read(resource, binding), /BUDGET/);
  assert.equal(ledger.outstandingReservedTokens, 0);
  const small = { ...resource, text: '', metadata: null };
  assert.throws(() => ledger.read(small, { ...binding, cursor: 'forged' }), /CURSOR/);
  const ample = make(); ample.read(resource, binding);
  assert.ok(ample.outstandingReservedTokens > 0); ample.close(); assert.equal(ample.outstandingReservedTokens, 0);
});
test('admission verifies receipts, remaining reservation and updates actual occupancy', () => {
  const ledger = make(10000);
  const admission = createRequestAdmission({ ...binding, hostGeneration: 1, policyEpoch: 1, profile: { version: 'v', contextLimit: 11000, outputLimit: 900, safetyMarginTokens: 100 }, readPolicyEpoch: () => 1, resourceLedger: ledger });
  const check = { executionId: binding.executionId, hostGeneration: 1, policyEpoch: 1, profileVersion: 'v', contextLimit: 11000, outputLimit: 900, requestSequence: 1, estimatedInputTokens: 100, estimatorId: 'test', retainedResourceReceipts: [] as Array<{receiptId:string;digest:string}> };
  assert.equal(admission.check(check).kind, 'allow');
  const page = ledger.read({ ...resource, text: 'body', metadata: null }, binding);
  assert.equal(page.kind, 'context-resource');
  assert.throws(() => admission.check({ ...check, requestSequence: 2, retainedResourceReceipts: [{ receiptId: 'bad', digest: 'bad' }] }), RequestAdmissionProtocolError);
  const denied = admission.check({ ...check, requestSequence: 2 });
  assert.equal(denied.kind, 'deny'); if (denied.kind === 'deny') assert.equal(denied.receipt.code, 'CONTEXT_STATE_MISMATCH');
});

test('reservation is included on every request, occupancy refresh avoids counting retained pages twice', () => {
  const ledger = new ResourceLedger({ ...binding, inputLimitTokens: 5000, initialOccupiedTokens: 100, estimateTokens: () => 1000 });
  const profile = { version: 'v', contextLimit: 6000, outputLimit: 900, safetyMarginTokens: 100 };
  const admission = createRequestAdmission({ ...binding, hostGeneration: 1, policyEpoch: 1, profile, readPolicyEpoch: () => 1, resourceLedger: ledger });
  const request = { executionId: binding.executionId, hostGeneration: 1, policyEpoch: 1, profileVersion: 'v', contextLimit: 6000, outputLimit: 900, requestSequence: 1, estimatedInputTokens: 100, estimatorId: 'test', retainedResourceReceipts: [] as Array<{receiptId:string;digest:string}> };
  assert.equal(admission.check(request).kind, 'allow');
  const page = ledger.read({ ...resource, text: 'body', metadata: null }, binding);
  if (page.kind !== 'context-resource') throw Error('page');
  assert.equal(ledger.outstandingReservedTokens, 1000);
  const receipts = [{ receiptId: page.receiptId, digest: resourcePageDigest(page) }];
  assert.equal(admission.check({ ...request, requestSequence: 2, estimatedInputTokens: 4000, retainedResourceReceipts: receipts }).kind, 'allow');
  assert.throws(() => ledger.read({ ...resource, sourceRef: 'new' }, binding), /BUDGET/);
  const deny = admission.check({ ...request, requestSequence: 3, estimatedInputTokens: 4001, retainedResourceReceipts: receipts });
  assert.equal(deny.kind, 'deny'); if (deny.kind === 'deny') assert.equal(deny.receipt.code, 'CONTEXT_BUDGET_EXCEEDED');
});

test('same-tick concurrent readers deliver one body and opaque cursor binds version and execution', async () => {
  const ledger = make();
  const pages = await Promise.all([Promise.resolve().then(() => ledger.read(resource, binding)), Promise.resolve().then(() => ledger.read(resource, binding))]);
  assert.equal(pages.filter(page => page.kind === 'context-resource').length, 1);
  assert.equal(pages.filter(page => page.kind === 'context-resource-reference').length, 1);
  const page = pages.find(page => page.kind === 'context-resource')!;
  if (page.kind !== 'context-resource') throw Error('page');
  assert.throws(() => ledger.read({ ...resource, sourceVersion: 'v2' }, { ...binding, cursor: page.nextCursor! }), /CURSOR/);
  assert.throws(() => ledger.read(resource, { ...binding, executionId: 'other', cursor: page.nextCursor! }), /SCOPE/);
  assert.throws(() => make().read(resource, { ...binding, cursor: page.nextCursor! }), /CURSOR/);
});
