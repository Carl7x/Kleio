import type { RetainedResourceReceipt } from './resources.ts';
/** Engine-neutral request admission shapes. Product policy owns these values; DSH types stay in the adapter. */

export const ADMISSION_DENIAL_CODES = ['CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_INVALIDATED', 'CONTEXT_STATE_MISMATCH'] as const;
export type AdmissionDenialCode = (typeof ADMISSION_DENIAL_CODES)[number];

/** Format check only. The adapter chooses the concrete estimator id; the product layer does not import DSH. */
export function isEstimatorId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/+@-]{0,80}$/.test(value);
}

export interface RequestCheck {
  executionId: string;
  hostGeneration: number;
  requestSequence: number;
  policyEpoch: number;
  profileVersion: string;
  contextLimit: number;
  outputLimit: number;
  estimatedInputTokens: number;
  estimatorId: string;
  retainedResourceReceipts: readonly RetainedResourceReceipt[];
}

export interface Admission {
  requestSequence: number;
  policyEpoch: number;
  hostGeneration: number;
}

/** Host-held denial. Counts and binding only — never prompt text, secrets, or resource bodies. */
export interface DenialReceipt {
  executionId: string;
  scopeId: string;
  hostGeneration: number;
  policyEpoch: number;
  requestSequence: number;
  code: AdmissionDenialCode;
  estimatedInputTokens: number;
  contextLimit: number;
  outputLimit: number;
  safetyMarginTokens: number;
}

export type AdmissionDecision =
  | { readonly kind: 'allow'; readonly admission: Admission }
  | { readonly kind: 'deny'; readonly receipt: DenialReceipt };
