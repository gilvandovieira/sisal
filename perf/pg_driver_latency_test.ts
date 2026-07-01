/**
 * Guard test for the `@sisal/pg` latency probe.
 *
 * Skipped unless `DATABASE_URL` points at a Postgres (same gating as the
 * `integration/` suites), so it stays out of the network-free unit run. It
 * asserts the invariants that must hold regardless of the underlying driver —
 * the builder is ~free and Sisal's executor adds nothing measurable over the
 * raw driver call — and it *characterizes* (loudly, without failing) the known
 * `@db/postgres` extended-protocol stall.
 *
 * The stall itself is an upstream driver bug, not a Sisal regression, so it is
 * reported rather than failed by default. Set `SISAL_PERF_STRICT=1` to turn it
 * into a hard failure — do that once `@sisal/pg` ships a `TCP_NODELAY` driver
 * and you want CI to keep parameterized latency low.
 *
 * @module
 */

import { assert } from "@std/assert";

import { runPgLatencyBenchmark } from "./pg_driver_latency.ts";

function databaseUrl(): string | undefined {
  try {
    return (globalThis as {
      Deno?: { env: { get(k: string): string | undefined } };
    })
      .Deno?.env.get("DATABASE_URL") ?? undefined;
  } catch {
    return undefined;
  }
}

const URL = databaseUrl();
const SKIP = URL === undefined;

/** Fail the stall characterization instead of only warning about it. */
const STRICT = Deno.env.get("SISAL_PERF_STRICT") === "1";
/** Parameterized round-trips slower than this (ms) count as "stalled". */
const STALL_P50_MS = 5;

Deno.test({
  name: "perf: @sisal/pg builder and executor add negligible latency",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { results } = await runPgLatencyBenchmark(URL!, {
      iters: 40,
      warmup: 10,
      includePostgresJs: false,
    });

    const by = (id: string) => {
      const summary = results.find((r) => r.id === id);
      assert(summary !== undefined, `missing latency path: ${id}`);
      return summary;
    };

    const render = by("sisal-render");
    const sisal = by("sisal-execute");
    const driver = by("driver-param");
    const inline = by("driver-inline");

    // The builder is essentially free: rendering a two-parameter query is
    // microseconds — 2 ms is a wide margin for a slow, contended CI box.
    assert(
      render.p50 < 2,
      `sisal render p50 ${
        render.p50.toFixed(3)
      } ms — builder unexpectedly slow`,
    );

    // Sisal's executor is a thin wrapper over the driver call: acquire →
    // queryObject → release. Its p50 must track the raw driver's, not exceed it
    // by a meaningful margin. The slack (2× + 3 ms) absorbs low-latency jitter
    // without letting a real regression through, and holds in both regimes
    // (stalled ~40 ms, or fast ~0.4 ms once a NODELAY driver lands).
    assert(
      sisal.p50 <= driver.p50 * 2 + 3,
      `sisal execute p50 ${sisal.p50.toFixed(2)} ms far exceeds raw driver ` +
        `${driver.p50.toFixed(2)} ms — Sisal added query overhead`,
    );

    // Characterize the @db/postgres extended-protocol stall: a parameterized
    // round-trip that is both slow and much slower than the same query inlined
    // is the Nagle × delayed-ACK signature. Report by default; fail if strict.
    const stallRatio = driver.p50 / Math.max(inline.p50, 1e-6);
    if (driver.p50 > STALL_P50_MS && stallRatio > 4) {
      const message = `@db/postgres extended-protocol stall: parameterized ` +
        `${driver.p50.toFixed(1)} ms vs inlined ${inline.p50.toFixed(2)} ms ` +
        `(${stallRatio.toFixed(0)}×). Not a Sisal cost — see ` +
        `perf/PG_ADAPTER_PERF_REPORT.md.`;
      if (STRICT) throw new Error(`SISAL_PERF_STRICT: ${message}`);
      console.warn(`⚠ ${message}`);
    }
  },
});
