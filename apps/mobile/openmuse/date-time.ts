import { localDateTime } from "../../../packages/openmuse-domain/src/date-time.ts";

export { localDateTime };

/** Resolve a local wall-clock time, rejecting gaps at daylight-saving transitions. */
export function zonedInstant(date: string, time: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    throw new Error("请输入完整的日期与时间。");
  const desired = Date.parse(`${date}T${time}:00Z`);
  if (
    !Number.isFinite(desired) ||
    new Date(desired).toISOString().slice(0, 16) !== `${date}T${time}`
  )
    throw new Error("请选择有效的日期与时间。");
  let candidate = desired;
  for (let pass = 0; pass < 4; pass++) {
    const local = localDateTime(new Date(candidate).toISOString(), timeZone);
    const actual = Date.parse(`${local.date}T${local.time}:00Z`);
    const delta = desired - actual;
    if (delta === 0) return new Date(candidate).toISOString();
    candidate += delta;
  }
  throw new Error("所选时区不存在该时刻。请另选时间。");
}

/**
 * The first existing instant of a local day. Day-range boundaries are an internal
 * computation, not a user-entered appointment time, so when a DST gap removes
 * midnight (e.g. America/Santiago springs forward 00:00→01:00) the boundary
 * clamps to the first existing local time instead of failing the whole query.
 */
export function startOfZonedDay(date: string, timeZone: string): string {
  try {
    return zonedInstant(date, "00:00", timeZone);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("does not exist")) throw error;
  }
  for (let minutes = 1; minutes < 24 * 60; minutes++) {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    try {
      return zonedInstant(date, time, timeZone);
    } catch {
      // Still inside the gap; keep walking toward the first existing time.
    }
  }
  throw new Error("所选时区在这一天没有对应的本地时间。");
}

/** Only fully serialized instants may reset a date editor's local text. */
export function isCompleteInstant(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
