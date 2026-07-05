/**
 * Window-math tests (v0.10 T15): `nextWindow` produces half-open, UTC
 * grain-aligned `[from, until)` windows that never extend past `now` — the
 * bucket-edge invariants that prevent off-by-one double-counting. Pure
 * functions; no database.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { OrmError } from "@sisal/core";
import {
  addGrain,
  nextWindow,
  truncateToGrain,
  windowAt,
  windowsInRange,
} from "../mod.ts";

const at = (iso: string): Date => new Date(iso);

Deno.test("truncateToGrain: floors to each UTC grain edge", () => {
  const instant = at("2026-03-15T13:45:30.123Z");
  assertEquals(
    truncateToGrain(instant, "year").toISOString(),
    "2026-01-01T00:00:00.000Z",
  );
  assertEquals(
    truncateToGrain(instant, "month").toISOString(),
    "2026-03-01T00:00:00.000Z",
  );
  assertEquals(
    truncateToGrain(instant, "day").toISOString(),
    "2026-03-15T00:00:00.000Z",
  );
  assertEquals(
    truncateToGrain(instant, "hour").toISOString(),
    "2026-03-15T13:00:00.000Z",
  );
  assertEquals(
    truncateToGrain(instant, "minute").toISOString(),
    "2026-03-15T13:45:00.000Z",
  );
  assertEquals(
    truncateToGrain(instant, "second").toISOString(),
    "2026-03-15T13:45:30.000Z",
  );
});

Deno.test("addGrain: calendar-aware month/year arithmetic", () => {
  assertEquals(
    addGrain(at("2026-01-31T00:00:00Z"), "month").toISOString(),
    // JS Date semantics: Jan 31 + 1 month lands on Mar 3 (2026 is not a leap
    // year) — irrelevant in practice because window edges are always
    // grain-truncated (day 1) before advancing.
    "2026-03-03T00:00:00.000Z",
  );
  assertEquals(
    addGrain(at("2026-02-01T00:00:00Z"), "month").toISOString(),
    "2026-03-01T00:00:00.000Z",
  );
  assertEquals(
    addGrain(at("2024-02-29T00:00:00Z"), "year").toISOString(),
    "2025-03-01T00:00:00.000Z",
  );
  assertEquals(
    addGrain(at("2026-03-15T13:00:00Z"), "hour").toISOString(),
    "2026-03-15T14:00:00.000Z",
  );
});

Deno.test("nextWindow: an aligned watermark yields one whole bucket", () => {
  assertEquals(
    nextWindow({
      watermark: "2026-03-15T13:00:00.000Z",
      grain: "hour",
      now: at("2026-03-15T15:30:00Z"),
    }),
    { from: "2026-03-15T13:00:00.000Z", until: "2026-03-15T14:00:00.000Z" },
  );
});

Deno.test("nextWindow: an unaligned watermark refolds its whole bucket", () => {
  // Never a partial tail: the upsert overwrites the bucket row, so a window
  // starting mid-bucket would replace full counts with an undercount. The
  // fold restarts at the bucket edge and idempotently recounts everything.
  assertEquals(
    nextWindow({
      watermark: "2026-03-15T13:20:00.000Z",
      grain: "hour",
      now: at("2026-03-15T15:30:00Z"),
    }),
    { from: "2026-03-15T13:00:00.000Z", until: "2026-03-15T14:00:00.000Z" },
  );
});

Deno.test("nextWindow: returns null while the bucket is still open", () => {
  // The 15:00 bucket closes at 16:00; at 15:30 there is nothing to run.
  assertEquals(
    nextWindow({
      watermark: "2026-03-15T15:00:00.000Z",
      grain: "hour",
      now: at("2026-03-15T15:30:00Z"),
    }),
    null,
  );
  // Boundary: `until == now` is runnable (half-open — the bucket just closed).
  assertEquals(
    nextWindow({
      watermark: "2026-03-15T15:00:00.000Z",
      grain: "hour",
      now: at("2026-03-15T16:00:00Z"),
    }),
    { from: "2026-03-15T15:00:00.000Z", until: "2026-03-15T16:00:00.000Z" },
  );
});

Deno.test("nextWindow: a fresh job starts from the declared start", () => {
  assertEquals(
    nextWindow({
      watermark: null,
      start: "2026-01-01T00:00:00.000Z",
      grain: "day",
      now: at("2026-01-05T00:00:00Z"),
    }),
    { from: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" },
  );
});

Deno.test("nextWindow: month windows follow calendar lengths", () => {
  assertEquals(
    nextWindow({
      watermark: "2026-02-01T00:00:00.000Z",
      grain: "month",
      now: at("2026-04-01T00:00:00Z"),
    }),
    { from: "2026-02-01T00:00:00.000Z", until: "2026-03-01T00:00:00.000Z" },
  );
});

Deno.test("nextWindow: no watermark and no start is a typed refusal", () => {
  const error = assertThrows(
    () => nextWindow({ watermark: null, grain: "hour", now: at("2026-01-01") }),
    OrmError,
  );
  assertEquals(error.code, "ETL_MISSING_START");
});

Deno.test("windowAt: one grain-aligned window, alignment enforced", () => {
  assertEquals(windowAt("2026-03-15T13:00:00.000Z", "hour"), {
    from: "2026-03-15T13:00:00.000Z",
    until: "2026-03-15T14:00:00.000Z",
  });
  const error = assertThrows(
    () => windowAt("2026-03-15T13:30:00Z", "hour"),
    OrmError,
  );
  assertEquals(error.code, "ETL_INVALID_WINDOW");
});

Deno.test("windowsInRange: partitions the range into successive windows", () => {
  assertEquals(
    windowsInRange(
      { from: "2026-01-01T00:00:00Z", until: "2026-01-01T03:00:00Z" },
      "hour",
    ),
    [
      { from: "2026-01-01T00:00:00.000Z", until: "2026-01-01T01:00:00.000Z" },
      { from: "2026-01-01T01:00:00.000Z", until: "2026-01-01T02:00:00.000Z" },
      { from: "2026-01-01T02:00:00.000Z", until: "2026-01-01T03:00:00.000Z" },
    ],
  );
  // Calendar grains keep calendar lengths.
  assertEquals(
    windowsInRange(
      { from: "2026-01-01T00:00:00Z", until: "2026-03-01T00:00:00Z" },
      "month",
    ),
    [
      { from: "2026-01-01T00:00:00.000Z", until: "2026-02-01T00:00:00.000Z" },
      { from: "2026-02-01T00:00:00.000Z", until: "2026-03-01T00:00:00.000Z" },
    ],
  );
});

Deno.test("windowsInRange: refuses unaligned or degenerate ranges", () => {
  const unaligned = assertThrows(
    () =>
      windowsInRange(
        { from: "2026-01-01T00:30:00Z", until: "2026-01-01T02:00:00Z" },
        "hour",
      ),
    OrmError,
  );
  assertEquals(unaligned.code, "ETL_INVALID_WINDOW");
  const backwards = assertThrows(
    () =>
      windowsInRange(
        { from: "2026-01-01T02:00:00Z", until: "2026-01-01T02:00:00Z" },
        "hour",
      ),
    OrmError,
  );
  assertEquals(backwards.code, "ETL_INVALID_WINDOW");
});

Deno.test("nextWindow: an unparsable watermark is a typed refusal", () => {
  const error = assertThrows(
    () =>
      nextWindow({
        watermark: "garbage",
        grain: "hour",
        now: at("2026-01-01"),
      }),
    OrmError,
  );
  assertEquals(error.code, "ETL_INVALID_WINDOW");
});
