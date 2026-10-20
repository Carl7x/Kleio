/** Execution-scoped request admission. Scope and profile come from the host; callers cannot switch them. */
import {
  isEstimatorId,
  type Admission,
  type AdmissionDecision,
  type DenialReceipt,
  type RequestCheck,
} from '../context-contracts/request-admission.ts';
import type { ResourceLedger } from './resource-ledger.ts';

export type { Admission, AdmissionDecision, DenialReceipt, RequestCheck } from '../context-contracts/request-admission.ts';

export const CONTEXT_BUDGET_EXCEEDED_MESSAGE = '这次任务需要的资料超出了本轮容量，已停止继续处理。';
export const CONTEXT_STATE_MISMATCH_MESSAGE = '执行中的资料保留状态无法核验，本次处理已停止。';
export const CONTEXT_INVALIDATED_MESSAGE = '执行使用的上下文策略已失效，本次处理已停止。已完成的效果仍保留。';

const CHECK_KEYS = [
  'executionId', 'hostGeneration', 'requestSequence', 'policyEpoch', 'profileVersion',
  'contextLimit', 'outputLimit', 'estimatedInputTokens', 'estimatorId', 'retainedResourceReceipts',
] as const;

export interface RequestAdmissionBinding {
  readonly executionId: string;
  readonly scopeId: string;
  readonly hostGeneration: number;
  readonly policyEpoch: number;
}

export interface RequestAdmissionProfile {
  readonly version: string;
  readonly contextLimit: number;
  readonly outputLimit: number;
  readonly safetyMarginTokens: number;
}

export interface RequestAdmission {
  readonly binding: RequestAdmissionBinding;
  readonly profile: RequestAdmissionProfile;
  check(input: unknown): AdmissionDecision;
  denialReceipt(): DenialReceipt | undefined;
}

export class RequestAdmissionProtocolError extends Error {
  constructor() {
    super('Request check was rejected.');
    this.name = 'RequestAdmissionProtocolError';
  }
}

export class RequestAdmissionConfigError extends Error {
  constructor() {
    super('Request admission configuration is incomplete.');
    this.name = 'RequestAdmissionConfigError';
  }
}

function protocol(): never {
  throw new RequestAdmissionProtocolError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) protocol();
  return value;
}

function token(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) protocol();
  return value;
}

/** True when estimated + output + margin is strictly above the context limit. Safe-integer inputs only. */
function overCapacity(estimated: number, output: number, margin: number, limit: number): boolean {
  if (estimated > limit) return true;
  const afterInput = limit - estimated;
  if (output > afterInput) return true;
  return margin > afterInput - output;
}

function parseCheck(input: unknown, hasLedger: boolean): RequestCheck {
  if (!isObject(input)) protocol();
  const keys = Object.keys(input);
  if (keys.length !== CHECK_KEYS.length || CHECK_KEYS.some(key => !Object.hasOwn(input, key))) protocol();
  const receipts = input.retainedResourceReceipts;
  // Legacy controllers have no resource authority; receipt-bearing requests require their bound ledger.
  if (!Array.isArray(receipts) || (!hasLedger && receipts.length !== 0)) protocol();
  for (const receipt of receipts) {
    if (!isObject(receipt) || Object.keys(receipt).length !== 2 || !Object.hasOwn(receipt, 'receiptId') || !Object.hasOwn(receipt, 'digest')) protocol();
    token(receipt.receiptId, 200);
    if (typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)) protocol();
  }
  const contextLimit = count(input.contextLimit, 1);
  const outputLimit = count(input.outputLimit, 1);
  if (outputLimit >= contextLimit) protocol();
  const estimatorId = input.estimatorId;
  if (!isEstimatorId(estimatorId)) protocol();
  return {
    executionId: token(input.executionId, 200),
    hostGeneration: count(input.hostGeneration, 0),
    requestSequence: count(input.requestSequence, 1),
    policyEpoch: count(input.policyEpoch, 0),
    profileVersion: token(input.profileVersion, 64),
    contextLimit,
    outputLimit,
    estimatedInputTokens: count(input.estimatedInputTokens, 0),
    estimatorId,
    retainedResourceReceipts: receipts,
  };
}

export function createRequestAdmission(input: {
  executionId: string;
  scopeId: string;
  hostGeneration: number;
  policyEpoch: number;
  profile: { version: string; contextLimit: number; outputLimit: number; safetyMarginTokens: number };
  readPolicyEpoch: () => number;
  resourceLedger?: ResourceLedger;
}): RequestAdmission {
  if (typeof input?.readPolicyEpoch !== 'function' || !isObject(input.profile)) throw new RequestAdmissionConfigError();
  let executionId: string;
  let scopeId: string;
  let version: string;
  let hostGeneration: number;
  let policyEpoch: number;
  let contextLimit: number;
  let outputLimit: number;
  let safetyMarginTokens: number;
  try {
    executionId = token(input.executionId, 200);
    scopeId = token(input.scopeId, 200);
    version = token(input.profile.version, 64);
    hostGeneration = count(input.hostGeneration, 0);
    policyEpoch = count(input.policyEpoch, 0);
    contextLimit = count(input.profile.contextLimit, 1);
    outputLimit = count(input.profile.outputLimit, 1);
    safetyMarginTokens = count(input.profile.safetyMarginTokens, 0);
  } catch (error) {
    if (error instanceof RequestAdmissionProtocolError) throw new RequestAdmissionConfigError();
    throw error;
  }
  if (outputLimit >= contextLimit) throw new RequestAdmissionConfigError();
  const binding: RequestAdmissionBinding = Object.freeze({ executionId, scopeId, hostGeneration, policyEpoch });
  const profile: RequestAdmissionProfile = Object.freeze({ version, contextLimit, outputLimit, safetyMarginTokens });
  const readPolicyEpoch = input.readPolicyEpoch;
  const ledger = input.resourceLedger;
  if (ledger && (ledger.scopeId !== scopeId || ledger.executionId !== executionId || ledger.inputLimitTokens !== contextLimit - outputLimit - safetyMarginTokens)) throw new RequestAdmissionConfigError();
  let expectedSequence = 1;
  let busy = false;
  let receipt: DenialReceipt | undefined;
  let unconfirmed = false;

  const deny = (request: RequestCheck, code: DenialReceipt['code'], epoch: number): AdmissionDecision => {
    receipt = Object.freeze({
      executionId: binding.executionId,
      scopeId: binding.scopeId,
      hostGeneration: binding.hostGeneration,
      policyEpoch: epoch,
      requestSequence: request.requestSequence,
      code,
      estimatedInputTokens: request.estimatedInputTokens,
      contextLimit: profile.contextLimit,
      outputLimit: profile.outputLimit,
      safetyMarginTokens: profile.safetyMarginTokens,
    });
    return { kind: 'deny', receipt };
  };

  return Object.freeze({
    binding,
    profile,
    denialReceipt: () => receipt,
    check(value: unknown): AdmissionDecision {
      if (receipt) return { kind: 'deny', receipt };
      if (unconfirmed || busy) {
        unconfirmed = true;
        protocol();
      }
      busy = true;
      try {
        const request = parseCheck(value, !!ledger);
        if (request.executionId !== binding.executionId || request.hostGeneration !== binding.hostGeneration) protocol();
        if (request.profileVersion !== profile.version || request.contextLimit !== profile.contextLimit || request.outputLimit !== profile.outputLimit) protocol();
        if (request.requestSequence !== expectedSequence) protocol();
        let current: number;
        try { current = readPolicyEpoch(); } catch { unconfirmed = true; protocol(); }
        if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) { unconfirmed = true; protocol(); }
        // A stale bound epoch is a real revocation. Any other epoch is a forged binding, not a budget decision.
        if (current !== binding.policyEpoch) {
          if (request.policyEpoch === binding.policyEpoch) return deny(request, 'CONTEXT_INVALIDATED', current);
          protocol();
        }
        if (request.policyEpoch !== binding.policyEpoch) protocol();
        if (ledger && !ledger.verifyRetained(request.retainedResourceReceipts)) return deny(request, 'CONTEXT_STATE_MISMATCH', current);
        const reserved = ledger?.outstandingReservedTokens ?? 0;
        if (reserved > profile.contextLimit || overCapacity(request.estimatedInputTokens + reserved, profile.outputLimit, profile.safetyMarginTokens, profile.contextLimit)) {
          return deny(request, 'CONTEXT_BUDGET_EXCEEDED', current);
        }
        ledger?.updateOccupiedTokens(request.estimatedInputTokens);
        expectedSequence += 1;
        const admission: Admission = Object.freeze({
          requestSequence: request.requestSequence,
          policyEpoch: current,
          hostGeneration: binding.hostGeneration,
        });
        return { kind: 'allow', admission };
      } finally { busy = false; }
    },
  });
}
