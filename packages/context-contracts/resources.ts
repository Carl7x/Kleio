/** Neutral, execution-scoped resource transport. Metadata is serialized as a separate paged stream. */
export interface ContextResource { readonly sourceRef: string; readonly sourceVersion: string; readonly text: string; readonly metadata: unknown }
export interface RetainedResourceReceipt { readonly receiptId: string; readonly digest: string }
export interface ResourcePage {
  readonly kind: 'context-resource'; readonly receiptId: string; readonly sourceRef: string;
  readonly sourceVersion: string; readonly pageIndex: number; readonly section: 'metadata' | 'text';
  readonly text: string; readonly nextCursor: string | null; readonly resourceComplete: boolean;
}
export interface ResourceReference { readonly kind: 'context-resource-reference'; readonly receiptId: string; readonly alreadyDelivered: true }
