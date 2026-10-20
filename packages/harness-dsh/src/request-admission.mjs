/** Pre-send gate for one explicit admission profile. Product policy stays on the host; this module only prices and asks. */
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const name = 'kleio-request-admission';
export const inject = ['llm'];

const STOP = 'Request admission stopped before the model call.';

function stop() {
  return new Error(STOP);
}

function pricedBlock(block) {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return false;
  if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string';
  if (block.type === 'tool-call') return typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string';
  return false;
}

function add(total, part) {
  if (!Number.isSafeInteger(part) || part < 0) throw stop();
  if (total > Number.MAX_SAFE_INTEGER - part) return Number.MAX_SAFE_INTEGER;
  return total + part;
}

/**
 * Price the immutable envelope with the pinned estimator.
 * Image, file, and unknown blocks stop before any structural fallback can price them as text.
 * @param {readonly unknown[]} messages
 * @param {readonly unknown[] | undefined} tools
 * @param {unknown} system
 * @param {{ estimateMessage(message: unknown): number; estimateToolsTokens(header: unknown): number }} estimator
 */
export function priceRequest(messages, tools, system, estimator) {
  if (!Array.isArray(messages) || typeof estimator?.estimateMessage !== 'function' || typeof estimator?.estimateToolsTokens !== 'function') throw stop();
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) throw stop();
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) || !Array.isArray(message.content)) throw stop();
    if (message.content.some(block => !pricedBlock(block))) throw stop();
  }
  if (system !== undefined && typeof system !== 'string') throw stop();
  let total = 0;
  for (const message of messages) total = add(total, estimator.estimateMessage(message));
  const systemMessage = messages.some(message => message.role === 'system');
  if (!systemMessage && typeof system === 'string' && system.length > 0) {
    total = add(total, estimator.estimateMessage({ role: 'system', content: [{ type: 'text', text: system }] }));
  }
  let toolTokens = 0;
  try {
    toolTokens = tools === undefined ? estimator.estimateToolsTokens(undefined) : Array.isArray(tools) ? estimator.estimateToolsTokens({ tools }) : undefined;
  } catch { throw stop(); }
  if (toolTokens === undefined) throw stop();
  return add(total, toolTokens);
}

// These are the exact public names produced by pinned dsh-mcp-client for the kleio server.
const RESOURCE_TOOLS = new Set(['mcp__kleio__skill_read', 'mcp__kleio__context_read']);
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
/** Only complete top-level pages in paired, successful tool messages are receipts. */
export function retainedResourceReceipts(messages) {
  const calls = new Map();
  const receipts = [];
  const answered = new Set();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'tool-call') {
        // A duplicated identity cannot select a different tool after the fact.
        calls.set(block.id, calls.has(block.id) ? null : block.name);
      }
    } else if (message.role === 'tool' && !message.isError && RESOURCE_TOOLS.has(calls.get(message.toolCallId)) && !answered.has(message.toolCallId)) {
      answered.add(message.toolCallId);
      if (message.content.length !== 1 || message.content[0].type !== 'text') continue;
      let page;
      try { page = JSON.parse(message.content[0].text); } catch { continue; }
      if (!page || page.kind !== 'context-resource' || typeof page.receiptId !== 'string') continue;
      receipts.push({ receiptId: page.receiptId, digest: createHash('sha256').update(canonical(page)).digest('hex') });
    }
  }
  return receipts;
}

function allowMatches(text, config, requestSequence) {
  let payload;
  try { payload = JSON.parse(text); } catch { return false; }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  const expected = ['decision', 'requestSequence', 'policyEpoch', 'hostGeneration'];
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(payload, key))) return false;
  return payload.decision === 'allow'
    && payload.requestSequence === requestSequence
    && payload.policyEpoch === config.policyEpoch
    && payload.hostGeneration === config.hostGeneration;
}

export function apply(ctx, config) {
  let estimatorPromise;
  let sequence = 0;
  const estimator = () => {
    estimatorPromise ??= import(pathToFileURL(config.estimatorModule).href);
    return estimatorPromise;
  };
  ctx.on('llm/stream', (options, next) => (async function* () {
    if (options?.signal?.aborted) throw stop();
    let estimatedInputTokens;
    try {
      const module = await estimator();
      estimatedInputTokens = priceRequest(options.messages, options.tools, options.system, module);
    } catch { throw stop(); }
    const requestSequence = ++sequence;
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetch(config.controlUrl, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { authorization: config.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          executionId: config.executionId,
          hostGeneration: config.hostGeneration,
          requestSequence,
          policyEpoch: config.policyEpoch,
          profileVersion: config.profileVersion,
          contextLimit: config.contextLimit,
          outputLimit: config.outputLimit,
          estimatedInputTokens,
          estimatorId: config.estimatorId,
          retainedResourceReceipts: retainedResourceReceipts(options.messages),
        }),
      });
      const text = await response.text();
      if (response.status !== 200 || text.length > 65536 || !allowMatches(text, config, requestSequence)) throw stop();
    } catch (error) {
      if (error instanceof Error && error.message === STOP) throw error;
      throw stop();
    }
    yield* next();
  })());
}
