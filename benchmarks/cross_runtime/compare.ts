/**
 * Formats the cross-runtime benchmark results (one JSON line per runtime,
 * emitted by bench.mjs) into a Node-vs-Bun comparison that keeps the two
 * variables separate: Sisal's own render speed (CPU) and, in the pg e2e, the
 * runtime+driver baseline vs Sisal's marginal overhead.
 *
 * Run indirectly via benchmarks/cross_runtime/run.sh. Excluded from the Deno
 * workspace checks (it sits beside the npm-only bench.mjs); keep it dependency
 * free so `deno run --allow-read compare.ts <results.jsonl>` just works.
 *
 * @module
 */

interface Result {
  runtime: string;
  version: string;
  temporalSource: "native" | "polyfill";
  render: Record<string, number>; // ns/op
  e2e?: {
    queries: number;
    rawRps: number;
    sisalRps: number;
    rawUsPerQuery: number;
    sisalUsPerQuery: number;
    overheadUsPerQuery: number;
    overheadPct: number;
  };
}

const file = Deno.args[0];
if (file === undefined) {
  console.error("usage: compare.ts <results.jsonl>");
  Deno.exit(1);
}

const results: Result[] = (await Deno.readTextFile(file))
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Result);

if (results.length === 0) {
  console.error("no results to compare");
  Deno.exit(1);
}

const us = (ns: number) => `${(ns / 1000).toFixed(3)}µs`;
const pad = (s: string, w: number) => s.padEnd(w);
const rpad = (s: string, w: number) => s.padStart(w);

const runtimes = results.map((r) =>
  `${r.runtime} v${r.version}` + (r.temporalSource === "polyfill" ? "*" : "")
);
const col = 16;
const hasPolyfill = results.some((r) => r.temporalSource === "polyfill");

// ---- Part 1: Sisal render (CPU) --------------------------------------------
console.log("Part 1 — Sisal render (CPU, no DB), ns/op — lower is faster\n");
const workloads = Object.keys(results[0].render);
const nameW = Math.max(20, ...workloads.map((w) => w.length + 2));
console.log(
  "  " + pad("workload", nameW) +
    runtimes.map((r) => rpad(r, col)).join("") +
    (results.length === 2 ? rpad("Δ (2nd/1st)", col) : ""),
);
for (const w of workloads) {
  const cells = results.map((r) => rpad(us(r.render[w]), col)).join("");
  let delta = "";
  if (results.length === 2) {
    const a = results[0].render[w];
    const b = results[1].render[w];
    const pct = ((b - a) / a) * 100;
    delta = rpad(`${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`, col);
  }
  console.log("  " + pad(w, nameW) + cells + delta);
}

// ---- Part 2: pg e2e --------------------------------------------------------
const withE2e = results.filter((r) => r.e2e);
if (withE2e.length > 0) {
  const rps = (n: number) => `${Math.round(n).toLocaleString()} q/s`;
  console.log(
    `\nPart 2 — pg e2e, serial point-selects, single connection ` +
      `(${withE2e[0].e2e!.queries}/sample)\n`,
  );
  const rows: Array<[string, (r: Result) => string]> = [
    [
      "raw driver (runtime+driver+db)",
      (r) => `${rps(r.e2e!.rawRps)} (${r.e2e!.rawUsPerQuery.toFixed(0)}µs)`,
    ],
    [
      "sisal",
      (r) => `${rps(r.e2e!.sisalRps)} (${r.e2e!.sisalUsPerQuery.toFixed(0)}µs)`,
    ],
    [
      "sisal cost / query",
      (r) =>
        `+${r.e2e!.overheadUsPerQuery.toFixed(1)}µs +${
          r.e2e!.overheadPct.toFixed(0)
        }%`,
    ],
  ];
  const metricW = Math.max(...rows.map(([label]) => label.length)) + 2;
  console.log(
    "  " + pad("metric", metricW) +
      withE2e.map((r) => rpad(r.runtime, col + 6)).join(""),
  );
  for (const [label, cell] of rows) {
    console.log(
      "  " + pad(label, metricW) +
        withE2e.map((r) => rpad(cell(r), col + 6)).join(""),
    );
  }
  console.log(
    "\n  raw driver = runtime + driver + database throughput ceiling; sisal\n" +
      "  cost/query is what the ORM adds on top (database round-trip cancels).\n" +
      "  Serial single-connection q/s = 1 / round-trip latency; a pool would\n" +
      "  multiply both columns.",
  );
} else {
  console.log("\nPart 2 — skipped (no DB_URL / no e2e results)");
}

if (hasPolyfill) {
  console.log(
    "\n* Temporal via @js-temporal/polyfill — this runtime has no native\n" +
      "  Temporal global (Deno and Node 24+ do). Sisal touches Temporal on the\n" +
      "  render path, so it needs the polyfill here; its cost is included above.",
  );
}
