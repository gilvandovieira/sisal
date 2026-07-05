/**
 * ORM execute-path CPU profiler (investigate-first).
 *
 * Question: the cross-runtime benchmark showed Sisal's per-query overhead
 * (~62µs on Node over postgres.js) is far above its pure render cost (~8µs).
 * Where does the rest go — the immutable builder chain, AST construction,
 * dialect rendering, or the execute dispatch itself?
 *
 * This isolates **100% of Sisal's CPU** with a zero-overhead canned driver
 * (returns fixed rows, no I/O, no adapter marshalling), so every nanosecond is
 * the library's own. It times the execute path as a growing prefix and reports
 * the **incremental** cost each stage adds:
 *
 *   1. eq() condition        — one operator allocation
 *   2. build chain           — select().from().where() (immutable builders)
 *   3. + toSql()             — the fragment-IR AST
 *   4. + render              — AST → { text, params } for the dialect
 *   5. + execute()           — dispatch + await + no-op decode (canned driver)
 *
 * The gap between (5) and the real e2e overhead is the adapter's result
 * marshalling (postgres.js row → OrmQueryResult, type coercion), which a canned
 * driver deliberately excludes.
 *
 * ```sh
 * deno run --allow-hrtime perf/orm_execute_profile.ts
 * PROFILE_ITERS=100000 deno run -A perf/orm_execute_profile.ts
 * ```
 *
 * Findings feed `perf/ORM_EXECUTE_PROFILE.md`.
 *
 * @module
 */

import {
  columns,
  createDatabase,
  defineTable,
  eq,
  renderSql,
} from "@sisal/orm";
import type { OrmDriver, OrmQueryResult, SqlQuery } from "@sisal/orm";

const ITERS = Number(Deno.env.get("PROFILE_ITERS") ?? "50000");
const SAMPLES = 15;
const WARMUP = 5;

const posts = defineTable("bench_posts", {
  id: columns.integer().primaryKey(),
  authorId: columns.integer().notNull(),
  title: columns.text().notNull(),
  status: columns.text().notNull().default("draft"),
  hotScore: columns.integer().notNull().default(0),
});
const p = posts.columns;

// Zero-overhead driver: the query never leaves the process. The row is keyed
// exactly as the projection aliases it, mirroring what a real driver returns for
// `select({ title, hot })` (columns come back pre-aliased from `phys AS key`).
const canned: OrmQueryResult<unknown> = {
  rows: [{ title: "hello", hot: 7 }],
  rowCount: 1,
};
const driver: OrmDriver = {
  query<T = unknown>(_query: SqlQuery): Promise<OrmQueryResult<T>> {
    return Promise.resolve(canned as OrmQueryResult<T>);
  },
  execute(_query: SqlQuery): Promise<OrmQueryResult> {
    return Promise.resolve(canned as OrmQueryResult);
  },
  close(): Promise<void> {
    return Promise.resolve();
  },
};
const db = createDatabase({ driver, dialect: "postgres" });

const projection = { title: p.title, hot: p.hotScore };

/** Median ns/op of a synchronous op after warm-up + samples. */
function benchSync(fn: () => unknown): number {
  for (let w = 0; w < WARMUP; w++) for (let i = 0; i < ITERS; i++) fn();
  const perOp: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) fn();
    perOp.push(((performance.now() - t0) * 1e6) / ITERS);
  }
  perOp.sort((a, b) => a - b);
  return perOp[Math.floor(perOp.length / 2)];
}

/** Median ns/op of an async op (awaited serially) after warm-up + samples. */
async function benchAsync(fn: () => Promise<unknown>): Promise<number> {
  const iters = Math.max(1, Math.floor(ITERS / 5)); // awaits are pricier
  for (let w = 0; w < WARMUP; w++) for (let i = 0; i < iters; i++) await fn();
  const perOp: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) await fn();
    perOp.push(((performance.now() - t0) * 1e6) / iters);
  }
  perOp.sort((a, b) => a - b);
  return perOp[Math.floor(perOp.length / 2)];
}

// Growing-prefix stages. Each builds on the previous so the delta is the cost
// that stage alone adds.
const buildChain = () => db.select(projection).from(posts).where(eq(p.id, 1));

const syncStages: Array<[string, () => unknown]> = [
  ["eq() condition", () => eq(p.id, 1)],
  ["+ build chain (select/from/where)", buildChain],
  ["+ toSql() (fragment IR)", () => buildChain().toSql()],
  [
    "+ render (text + params)",
    () => renderSql(buildChain().toSql(), { dialect: "postgres" }),
  ],
];

const us = (ns: number) => `${(ns / 1000).toFixed(2)}µs`;

console.log(
  `ORM execute-path profile — zero-overhead driver (pure Sisal CPU)\n` +
    `  iters/sample ${ITERS.toLocaleString()} · samples ${SAMPLES} · median ns/op\n`,
);

const cumulative: Array<[string, number]> = [];
for (const [name, fn] of syncStages) cumulative.push([name, benchSync(fn)]);
const executeNs = await benchAsync(() => buildChain().execute());
cumulative.push(["+ execute() (dispatch + await + decode)", executeNs]);

const nameW = Math.max(...cumulative.map(([n]) => n.length)) + 2;
console.log(
  "  " + "stage".padEnd(nameW) + "cumulative".padStart(12) +
    "adds".padStart(12) + "  share",
);
console.log("  " + "─".repeat(nameW + 34));
let prev = 0;
const total = cumulative[cumulative.length - 1][1];
for (const [name, ns] of cumulative) {
  const adds = ns - prev;
  const share = (adds / total) * 100;
  console.log(
    "  " + name.padEnd(nameW) + us(ns).padStart(12) + us(adds).padStart(12) +
      `  ${share >= 0 ? share.toFixed(0) : "0"}%`,
  );
  prev = ns;
}
console.log(
  `\n  Total per-query Sisal CPU (canned driver): ${us(total)}.\n` +
    `  A real adapter adds result marshalling on top (excluded here).`,
);
