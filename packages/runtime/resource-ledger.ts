import { createHash, randomBytes } from 'node:crypto';
import type { ContextResource, ResourcePage, ResourceReference, RetainedResourceReceipt } from '../context-contracts/resources.ts';

export function canonicalResourceJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error('Invalid resource data.');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalResourceJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalResourceJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function resourcePageDigest(page: unknown): string { return createHash('sha256').update(canonicalResourceJson(page)).digest('hex'); }
const opaque = () => randomBytes(24).toString('hex');
interface Stored { page: ResourcePage; cost: number; delivered: boolean; present: boolean }
export class ResourceLedger {
  readonly scopeId: string;
  readonly executionId: string;
  readonly inputLimitTokens: number;
  #occupied: number;
  #reserved = 0;
  #closed = false;
  #resources = new Map<string, Stored[]>();
  #cursors = new Map<string, { key: string; index: number }>();
  #estimate: (text: string) => number;
  constructor(input: { scopeId: string; executionId: string; inputLimitTokens: number; initialOccupiedTokens: number; estimateTokens?: (text: string) => number }) {
    if (!input.scopeId || !input.executionId || !Number.isSafeInteger(input.inputLimitTokens) || input.inputLimitTokens < 1 || !Number.isSafeInteger(input.initialOccupiedTokens) || input.initialOccupiedTokens < 0) throw new Error('Invalid resource ledger configuration.');
    this.scopeId = input.scopeId; this.executionId = input.executionId; this.inputLimitTokens = input.inputLimitTokens;
    this.#occupied = input.initialOccupiedTokens;
    // Byte-based conservative estimate plus message/call framing reserve for every page.
    this.#estimate = input.estimateTokens ?? (text => Buffer.byteLength(text, 'utf8') + 256);
  }
  get outstandingReservedTokens(): number { return this.#reserved; }
  updateOccupiedTokens(tokens: number): void {
    if (this.#closed || !Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid resource ledger state.');
    this.#occupied = tokens;
  }
  read(resource: ContextResource, binding: { scopeId: string; executionId: string; cursor?: string }): ResourcePage | ResourceReference {
    if (this.#closed || binding.scopeId !== this.scopeId || binding.executionId !== this.executionId) throw new Error('RESOURCE_SCOPE_MISMATCH');
    if (!resource.sourceRef || !resource.sourceVersion || typeof resource.text !== 'string') throw new Error('Invalid resource data.');
    const key = canonicalResourceJson([resource.sourceRef, resource.sourceVersion]);
    let index = 0;
    if (binding.cursor !== undefined) {
      const cursor = this.#cursors.get(binding.cursor);
      if (!cursor || cursor.key !== key) throw new Error('INVALID_RESOURCE_CURSOR');
      index = cursor.index;
    }
    let pages = this.#resources.get(key);
    if (!pages) {
      if (binding.cursor !== undefined) throw new Error('INVALID_RESOURCE_CURSOR');
      const drafts: ResourcePage[] = [];
      for (const [section, body] of [['metadata', canonicalResourceJson(resource.metadata)], ['text', resource.text]] as const) {
        const chars = Array.from(body);
        let offset = 0;
        do {
          const page = { kind: 'context-resource' as const, receiptId: opaque(), sourceRef: resource.sourceRef, sourceVersion: resource.sourceVersion, pageIndex: drafts.length, section, text: '', nextCursor: opaque(), resourceComplete: false };
          if (Buffer.byteLength(JSON.stringify(page)) > 4096) throw new Error('RESOURCE_ENVELOPE_TOO_LARGE');
          while (offset < chars.length && Buffer.byteLength(JSON.stringify({ ...page, text: page.text + chars[offset] })) <= 4096) page.text += chars[offset++]!;
          if (offset < chars.length && page.text.length === 0) throw new Error('RESOURCE_ENVELOPE_TOO_LARGE');
          drafts.push(page);
        } while (offset < chars.length);
      }
      const last = drafts.at(-1)!;
      drafts[drafts.length - 1] = { ...last, nextCursor: null, resourceComplete: true };
      pages = drafts.map(page => {
        const cost = this.#estimate(JSON.stringify(page));
        if (!Number.isSafeInteger(cost) || cost < 1) throw new Error('Invalid resource estimate.');
        return { page: Object.freeze(page), cost, delivered: false, present: false };
      });
      const cost = pages.reduce((sum, page) => sum + page.cost, 0);
      if (!Number.isSafeInteger(cost) || cost > this.inputLimitTokens - this.#occupied - this.#reserved) throw new Error('CONTEXT_BUDGET_EXCEEDED');
      this.#reserved += cost;
      this.#resources.set(key, pages);
      pages.forEach((stored, i) => { if (stored.page.nextCursor) this.#cursors.set(stored.page.nextCursor, { key, index: i + 1 }); });
    }
    const stored = pages[index]!;
    if (stored.delivered) return Object.freeze({ kind: 'context-resource-reference', receiptId: stored.page.receiptId, alreadyDelivered: true });
    stored.delivered = true;
    this.#reserved -= stored.cost;
    // Delivered pages awaiting the next actual envelope still occupy capacity.
    this.#occupied += stored.cost;
    return stored.page;
  }
  verifyRetained(receipts: readonly RetainedResourceReceipt[]): boolean {
    if (this.#closed) return false;
    const expected = [...this.#resources.values()].flat().filter(page => page.delivered);
    if (expected.length !== receipts.length) return false;
    const found = new Map(receipts.map(receipt => [receipt.receiptId, receipt.digest]));
    if (found.size !== receipts.length || expected.some(stored => found.get(stored.page.receiptId) !== resourcePageDigest(stored.page))) return false;
    expected.forEach(stored => { stored.present = true; });
    return true;
  }
  close(): void { this.#closed = true; this.#reserved = 0; this.#resources.clear(); this.#cursors.clear(); }
}
