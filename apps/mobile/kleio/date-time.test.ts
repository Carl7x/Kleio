import assert from "node:assert/strict";
import test from "node:test";
import { localDateTime, MissingLocalTimeError, startOfZonedDay, zonedInstant } from "./date-time.ts";

test("a spring-forward midnight clamps to the first existing local time", () => {
  assert.throws(() => zonedInstant("2019-09-08", "00:00", "America/Santiago"), MissingLocalTimeError);
  const start = startOfZonedDay("2019-09-08", "America/Santiago");
  assert.equal(localDateTime(start, "America/Santiago").time, "01:00");
  assert.equal(localDateTime(start, "America/Santiago").date, "2019-09-08");
  assert.doesNotMatch(new MissingLocalTimeError().message, /does not exist/i);
});

test("a normal local midnight stays midnight", () => {
  const start = startOfZonedDay("2019-09-07", "America/Santiago");
  assert.equal(localDateTime(start, "America/Santiago").time, "00:00");
  assert.equal(localDateTime(start, "America/Santiago").date, "2019-09-07");
});
