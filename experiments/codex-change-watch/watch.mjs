import { diffLines } from './page-diff.mjs';

export const LIMITS = Object.freeze({ textCharacters: 120000, lines: 2000, lineCharacters: 2000 });
const emptyDiff = () => ({ added: [], updated: [], removed: [], ignoredMetadata: [] });
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && /^[\w.-]{1,100}$/u.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 4000) throw new TypeError('sourceUrl must be an HTTP(S) URL');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('sourceUrl requires HTTP(S), without credentials or fragments');
  }
  return url.href;
}

function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function readWatch(input) {
  if (!input || !id(input.id) || !positive(input.revision)) throw new TypeError('watch requires id and positive revision');
  if (typeof input.active !== 'boolean' || typeof input.ignoreRelativeMetadata !== 'boolean') {
    throw new TypeError('active and ignoreRelativeMetadata must be explicit booleans');
  }
  if (typeof input.region !== 'string' || !input.region.trim() || input.region.length > 200) {
    throw new TypeError('watch requires a stable, bounded region identifier');
  }
  return { id: input.id, revision: input.revision, sourceUrl: sourceUrl(input.sourceUrl),
    region: input.region, active: input.active, ignoreRelativeMetadata: input.ignoreRelativeMetadata };
}

/** Whitespace and ordering are not significant for this text-region comparator.
 * Reject incomplete data rather than silently clipping away a meaningful edit. */
function readLines(text, emptyConfirmed) {
  if (typeof text !== 'string') return { error: 'invalid_text' };
  if (text.length > LIMITS.textCharacters) return { error: 'input_too_large' };
  const raw = text.normalize('NFC').split(/\r?\n/u).map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  if (raw.length > LIMITS.lines || raw.some(line => line.length > LIMITS.lineCharacters)) return { error: 'input_too_large' };
  if (!raw.length && emptyConfirmed !== true) return { error: 'unconfirmed_empty' };
  // Duplicate identical rows can be meaningful (e.g. stock counts). Do not
  // silently deduplicate them. pair() preserves their multiplicity.
  return { lines: raw };
}

function initialState(watch) {
  return { schema: 1, watchId: watch.id, revision: watch.revision, sourceUrl: watch.sourceUrl,
    region: watch.region, ignoreRelativeMetadata: watch.ignoreRelativeMetadata,
    lastSequence: 0, lastObservationId: null, lastCapturedAt: null, baseline: null };
}

function stateFor(watch, state) {
  if (state == null) return initialState(watch);
  if (state.schema !== 1 || state.watchId !== watch.id || !positive(state.revision)
    || !Number.isSafeInteger(state.lastSequence) || state.lastSequence < 0) throw new TypeError('Invalid saved state');
  if (state.revision > watch.revision) throw new TypeError('Caller used an older watch revision than saved state');
  if (state.revision < watch.revision) return initialState(watch);
  if (state.sourceUrl !== watch.sourceUrl || state.region !== watch.region
    || state.ignoreRelativeMetadata !== watch.ignoreRelativeMetadata) {
    throw new TypeError('A source, region or comparison-policy change must increment watch.revision');
  }
  if (state.lastSequence > 0 && (!id(state.lastObservationId) || !timestamp(state.lastCapturedAt))) throw new TypeError('Invalid saved cursor');
  const b = state.baseline;
  if (b !== null && (!b || !id(b.observationId) || !positive(b.sequence) || b.sequence > state.lastSequence
    || !timestamp(b.capturedAt) || !Array.isArray(b.lines) || b.lines.length > LIMITS.lines
    || b.lines.some(line => typeof line !== 'string' || line.length > LIMITS.lineCharacters)
    || b.lines.reduce((n, line) => n + line.length, 0) > LIMITS.textCharacters)) {
    throw new TypeError('Invalid saved baseline');
  }
  return copy(state);
}

const messages = {
  baseline: '已建立首次观察记录；还没有旧记录可用于判断变化。',
  changed: '关注区域出现内容变化，已列出新增、修改和移除的证据。',
  unchanged: '本次检查完整，关注区域未发现内容变化。',
  failed: '本次读取失败，无法判断是否有变化。',
  partial: '本次内容不完整，保留上一次完整记录。',
  unconfirmed_empty: '本次读取为空，尚不能确认内容确实已被移除。',
  input_too_large: '本次内容超出比较范围，无法可靠判断变化。',
  invalid_text: '本次没有可比较的文本。',
  source_mismatch: '观察来源或区域与当前关注范围不同，无法比较。',
  invalid_observation: '观察记录缺少有效的身份、序号或时间。',
  inactive: '关注事项已暂停或停止，本次不处理。',
  stale_revision: '这是旧条件下的结果，本次不处理。',
  wrong_watch: '这条观察属于另一个关注事项，本次不处理。',
  replayed: '这次观察已处理，不重复产生结果。',
  out_of_order: '这是较早的观察结果，不覆盖后续记录。',
  observation_conflict: '观察身份与序号冲突，需要读取当前状态后核对。',
  time_regression: '本次观察时间早于已处理记录，不覆盖基线。',
};

function result(decision, reason, state, watch, observation, diff = emptyDiff(), evidence = null) {
  const publish = ['baseline', 'changed', 'attention'].includes(decision);
  return { decision, reason, summary: messages[reason], shouldNotify: publish,
    // An idempotency hint for a *persisted* outbox, not a claim of delivery.
    eventKey: publish && id(observation?.id)
      ? `watch:${watch.id}:r${watch.revision}:${observation.id}` : null,
    diff, evidence, nextState: copy(state) };
}

/**
 * Pure, offline observation comparison. No timers, network, memory, model,
 * database or delivery effects. A caller MUST commit nextState and any outbox
 * intent in one compare-and-swap transaction, checking watch.revision/active.
 * `shouldNotify` is a product-policy suggestion, never a send operation.
 */
export function evaluateObservation(watchInput, savedState, observation) {
  const watch = readWatch(watchInput);
  // Validate saved state even when the incoming result will be ignored.
  const state = stateFor(watch, savedState);
  const ignored = reason => result('ignored', reason, savedState ?? state, watch, observation);
  const attention = (reason, next = state) => result('attention', reason, next, watch, observation);
  if (!watch.active) return ignored('inactive');
  if (!observation || !id(observation.id) || !positive(observation.sequence) || !timestamp(observation.capturedAt)) return attention('invalid_observation');
  if (observation.watchId !== watch.id) return ignored('wrong_watch');
  if (observation.revision !== watch.revision) return ignored('stale_revision');
  if (observation.sequence === state.lastSequence) return observation.id === state.lastObservationId
    ? ignored('replayed') : attention('observation_conflict');
  if (observation.sequence < state.lastSequence) return ignored('out_of_order');
  if (observation.id === state.lastObservationId) return attention('observation_conflict');
  if (state.lastCapturedAt && Date.parse(observation.capturedAt) < Date.parse(state.lastCapturedAt)) return attention('time_regression');
  let url;
  try { url = sourceUrl(observation.sourceUrl); } catch { return attention('source_mismatch'); }
  if (url !== watch.sourceUrl || observation.region !== watch.region) return attention('source_mismatch');
  const advanced = { ...state, lastSequence: observation.sequence, lastObservationId: observation.id, lastCapturedAt: observation.capturedAt };
  if (observation.status === 'failed') return attention('failed', advanced);
  if (observation.status !== 'ok' || observation.complete !== true) return attention('partial', advanced);
  const parsed = readLines(observation.text, observation.emptyConfirmed);
  if (parsed.error) return attention(parsed.error, advanced);
  const baseline = { observationId: observation.id, sequence: observation.sequence, capturedAt: observation.capturedAt, lines: parsed.lines };
  const diff = state.baseline ? diffLines(state.baseline.lines, parsed.lines, watch) : emptyDiff();
  const evidence = { sourceUrl: watch.sourceUrl, region: watch.region,
    previous: copy(state.baseline), current: copy(baseline) };
  const decision = !state.baseline ? 'baseline'
    : diff.added.length + diff.updated.length + diff.removed.length > 0 ? 'changed' : 'unchanged';
  return result(decision, decision, { ...advanced, baseline }, watch, observation, diff, evidence);
}
