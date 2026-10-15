import { Cron } from 'croner';

/**
 * Date calculator only. Croner does not own Kleio's queue, pause, or delivery.
 * Dispatch, catch-up, and "one occurrence is never replayed" stay in WorkRuntime.
 * The five-field rules and DST policy match OpenMausBot's routine-schedule.
 */
export interface RoutineCronSchedule {
  type: 'cron';
  expression: string;
  /** Explicit IANA timezone; independent of the server timezone. */
  timeZone: string;
}

const MAX_EXPRESSION_LENGTH = 256;
const MAX_PREVIEW_RUNS = 1000;

function cronCalculator(value: unknown): { schedule: RoutineCronSchedule; cron: Cron } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a valid cron schedule');
  const input = value as Partial<RoutineCronSchedule>;
  if (input.type !== 'cron' || typeof input.expression !== 'string') throw new Error('Choose a valid cron schedule');
  if (Object.keys(input).some(key => !['type', 'expression', 'timeZone'].includes(key))) {
    throw new Error('Cron schedules accept only type, expression and timeZone; start/end dates and other restrictions are not supported');
  }
  const expression = input.expression.trim().replace(/\s+/g, ' ');
  if (expression.length > MAX_EXPRESSION_LENGTH || expression.split(' ').length !== 5 || expression.includes('@')) {
    throw new Error('Cron must have five fields: minute hour day-of-month month weekday (no seconds, year, or macros)');
  }
  const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
  if (timeZone.length > 128 || !(timeZone === 'UTC' || /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(timeZone))) {
    throw new Error('Choose an IANA timezone such as America/New_York, Asia/Kolkata, or UTC');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); }
  catch { throw new Error('Choose a valid IANA timezone such as America/New_York, Asia/Kolkata, or UTC'); }
  try {
    const cron = new Cron(expression, { timezone: timeZone, mode: '5-part', paused: true });
    return { schedule: { type: 'cron', expression, timeZone }, cron };
  } catch (error) {
    throw new Error(`Invalid cron expression: ${(error as Error).message}`);
  }
}

function calculationDate(after: number): Date {
  const date = new Date(after);
  if (!Number.isFinite(after) || !Number.isFinite(date.getTime())) throw new Error('Choose a valid cron preview date');
  return date;
}

function futureRuns(cron: Cron, after: number, count: number): number[] {
  const from = calculationDate(after);
  // Croner resolves an ambiguous wall-clock time to its first occurrence.
  // If the cursor is already in the second occurrence, its first candidate
  // can therefore be in the past. Ask for more candidates and discard those.
  const maximum = count + 1440;
  let requested = count;
  while (true) {
    const candidates = cron.nextRuns(requested, from);
    const runs: number[] = [];
    for (const date of candidates) {
      const at = date.getTime();
      if (!Number.isFinite(at)) throw new Error('The cron schedule produced an invalid date');
      if (at > (runs.at(-1) ?? after)) runs.push(at);
      if (runs.length === count) return runs;
    }
    if (candidates.length < requested || requested === maximum) return runs;
    requested = Math.min(maximum, requested * 2);
  }
}

/** Normalize once at the trust boundary, rejecting impossible schedules. */
export function normalizeCronSchedule(value: unknown, after = Date.now()): RoutineCronSchedule {
  const { schedule, cron } = cronCalculator(value);
  if (!futureRuns(cron, after, 1).length) throw new Error('This cron expression has no future runs. Choose dates that exist.');
  return schedule;
}

/** Strictly-future instants. Missing DST times advance; repeated times use the first occurrence. */
export function nextCronRuns(schedule: RoutineCronSchedule, after: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_PREVIEW_RUNS) throw new Error('Choose between 1 and 1000 cron preview runs');
  const { cron } = cronCalculator(schedule);
  return futureRuns(cron, after, count);
}

/** The next cron instant. Inclusive keeps a slot that lands exactly on the anchor. */
export function nextScheduledInstant(schedule: RoutineCronSchedule, anchor: number, inclusive: boolean): number {
  const instant = nextCronRuns(schedule, inclusive ? anchor - 1 : anchor, 1)[0];
  if (instant === undefined) throw new Error('This cron expression has no future runs. Choose dates that exist.');
  return instant;
}

/**
 * One catch-up instant: the latest due slot at or after `earliest` and at or before `now`.
 * Missed slots between them are not returned and must not be replayed.
 */
export function coalesceCronOccurrence(schedule: RoutineCronSchedule, earliest: number, now: number): { occurrence: number; following?: number } {
  const occurrence = latestDueAt(schedule, earliest, now);
  const following = nextCronRuns(schedule, occurrence, 1)[0];
  return following === undefined ? { occurrence } : { occurrence, following };
}

function latestDueAt(schedule: RoutineCronSchedule, earliest: number, now: number): number {
  if (!(earliest <= now)) return earliest;
  let best = earliest;
  let low = earliest - 1;
  let high = now;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    if (high - low <= 1) break;
    const mid = low + Math.floor((high - low) / 2);
    const next = nextCronRuns(schedule, mid, 1)[0];
    if (next === undefined || next > now) high = mid;
    else {
      best = next;
      if (next <= low) break;
      low = next;
    }
  }
  let cursor = best;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const batch = nextCronRuns(schedule, cursor, 1000);
    const due = batch.filter(instant => instant >= earliest && instant <= now);
    const tail = due.at(-1);
    if (tail === undefined) break;
    best = tail;
    if (due.length < batch.length || tail === cursor) break;
    cursor = tail;
  }
  return best;
}
