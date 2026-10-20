/** Test-only interception of the actual pinned DSH request; never a product policy. */
import { appendFileSync } from 'node:fs';

export const name = 'kleio-context-boundary-probe';
export const inject = ['llm', 'tokenMeter'];

export function apply(ctx, config) {
  let sequence = 0;
  const record = value => appendFileSync(config.recordPath, JSON.stringify(value) + '\n', { mode: 0o600 });
  ctx.on('llm/stream', (options, next) => (async function* () {
    const current = ++sequence;
    const input = JSON.stringify({ messages: options.messages, tools: options.tools });
    record({ phase: 'before', sequence: current, messages: options.messages, tools: options.tools,
      frozen: Object.isFrozen(options) && Object.isFrozen(options.messages)
        && options.messages.every(message => Object.isFrozen(message)),
      tokenMeterPresent: typeof ctx.tokenMeter.measure === 'function' });
    if (current === config.denyAt) throw new Error(`KLEIO_G0_DENIED_REQUEST_${current}`);
    yield* next();
    record({ phase: 'after', sequence: current,
      unchanged: input === JSON.stringify({ messages: options.messages, tools: options.tools }) });
  })());
}
