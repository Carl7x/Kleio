import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledJobs } from 'croner';
import { coalesceCronOccurrence, nextCronRuns, nextScheduledInstant, normalizeCronSchedule, type RoutineCronSchedule } from './runtime-schedule.ts';

const schedule = (expression: string, timeZone = 'UTC'): RoutineCronSchedule => ({ type: 'cron', expression, timeZone });
const runs = (expression: string, after: string, count = 3, timeZone = 'UTC') =>
  nextCronRuns(schedule(expression, timeZone), Date.parse(after), count).map(at => new Date(at).toISOString());

test('normalizes five fields and keeps the chosen timezone', () => {
  assert.deepEqual(normalizeCronSchedule(schedule('  0  9\t1 * *  ', ' Asia/Kolkata ')), schedule('0 9 1 * *', 'Asia/Kolkata'));
  assert.deepEqual(runs('0 9 1 * *', '2026-09-13T12:00:00Z', 3, 'Asia/Kolkata'), [
    '2026-10-01T03:30:00.000Z', '2026-11-01T03:30:00.000Z', '2026-12-01T03:30:00.000Z',
  ]);
});

test('calculates weekday runs strictly after the cursor', () => {
  assert.deepEqual(runs('0 9 * * MON-FRI', '2026-09-11T09:00:00Z', 2), ['2026-09-14T09:00:00.000Z', '2026-09-15T09:00:00.000Z']);
  assert.deepEqual(runs('15 9 * * *', '2026-09-13T09:14:59.999Z', 2), ['2026-09-13T09:15:00.000Z', '2026-09-14T09:15:00.000Z']);
});

test('advances a missing DST hour and runs a repeated hour once', () => {
  assert.deepEqual(runs('30 2 * * *', '2026-03-07T00:00:00Z', 3, 'America/New_York'), [
    '2026-03-07T07:30:00.000Z', '2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z',
  ]);
  assert.deepEqual(runs('30 1 * * *', '2026-10-31T00:00:00Z', 3, 'America/New_York'), [
    '2026-10-31T05:30:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z',
  ]);
  assert.deepEqual(runs('30 1 * * *', '2026-11-01T05:45:00Z', 1, 'America/New_York'), ['2026-11-02T06:30:00.000Z']);
});

test('rejects a zone that is not a named IANA timezone', () => {
  assert.throws(() => normalizeCronSchedule(schedule('0 9 1 * *', 'Mars/Olympus')), /IANA timezone/);
  assert.throws(() => normalizeCronSchedule(schedule('0 9 31 2 *')), /no future runs/);
});

test('Shanghai weekdays skip the weekend', () => {
  const weekdays = schedule('0 9 * * MON-FRI', 'Asia/Shanghai');
  const fridayMorning = Date.parse('2026-10-16T02:00:00.000Z');
  assert.equal(new Date(nextScheduledInstant(weekdays, fridayMorning, false)).toISOString(), '2026-10-19T01:00:00.000Z');
  const saturday = Date.parse('2026-10-17T02:00:00.000Z');
  assert.equal(new Date(nextScheduledInstant(weekdays, saturday, false)).toISOString(), '2026-10-19T01:00:00.000Z');
  const monday = Date.parse('2026-10-19T01:00:00.000Z');
  assert.equal(new Date(nextScheduledInstant(weekdays, monday, true)).toISOString(), '2026-10-19T01:00:00.000Z');
});

test('a missed Friday collapses to the latest due Monday', () => {
  const weekdays = schedule('0 9 * * MON-FRI', 'Asia/Shanghai');
  const friday = Date.parse('2026-10-16T01:00:00.000Z');
  const monday = Date.parse('2026-10-19T01:00:00.000Z');
  const coalesced = coalesceCronOccurrence(weekdays, friday, monday);
  assert.equal(new Date(coalesced.occurrence).toISOString(), '2026-10-19T01:00:00.000Z');
  assert.equal(new Date(coalesced.following ?? 0).toISOString(), '2026-10-20T01:00:00.000Z');
});

test('daily catch-up keeps the latest due morning', () => {
  const daily = schedule('0 9 * * *', 'UTC');
  const start = Date.parse('2026-10-01T09:00:00.000Z');
  const later = Date.parse('2026-10-11T09:00:00.000Z');
  const coalesced = coalesceCronOccurrence(daily, start, later);
  assert.equal(new Date(coalesced.occurrence).toISOString(), '2026-10-11T09:00:00.000Z');
  assert.equal(new Date(coalesced.following ?? 0).toISOString(), '2026-10-12T09:00:00.000Z');
});

test('the calculator does not register a timer', () => {
  const before = scheduledJobs.length;
  const value = normalizeCronSchedule(schedule('0 9 * * MON-FRI', 'Asia/Shanghai'));
  assert.equal(nextCronRuns(value, Date.parse('2026-10-16T02:00:00.000Z'), 1).length, 1);
  assert.equal(scheduledJobs.length, before);
});
