/** Explicit controlled-profile declaration and capacities for synthetic recording engines. */
export const TEST_CONTEXT_CAPABILITIES = { bundle: 1, admission: 1, receipts: 1 } as const;
export const TEST_MODEL_CAPACITY = { contextWindow: 131072, maxTokens: 8192 } as const;
