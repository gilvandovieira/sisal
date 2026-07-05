# ORM execute-path profile

**Question.** The cross-runtime benchmark showed Sisal's per-query overhead on
Node/postgres.js (~60–62µs) is far above its pure render cost (~8µs). Where does
the rest go?

**Answer.** Almost none of it is Sisal's CPU. Sisal's own per-query cost is
**6.6µs**; the ~35µs gap that made Sisal look slow is **server-side
parse+plan**, because the pg adapter runs queries through postgres.js
`.unsafe(text, params)` **without prepared statements**, while a hand-written
tagged-template query is prepared and cached.

## 1. Sisal CPU is 6.6µs/query (zero-overhead driver)

`perf/orm_execute_profile.ts` injects a canned driver (no I/O, no marshalling),
so every nanosecond is the library. Growing-prefix stages, median ns/op:

| stage                                     | cumulative |   adds | share |
| ----------------------------------------- | ---------: | -----: | ----: |
| `eq()` condition                          |     0.61µs | 0.61µs |    9% |
| + build chain (select/from/where)         |     0.80µs | 0.19µs |    3% |
| + `toSql()` (fragment IR)                 |     3.68µs | 2.88µs |   44% |
| + render (text + params)                  |     6.68µs | 3.00µs |   46% |
| + `execute()` (dispatch + await + decode) |     6.58µs |   ~0µs |    0% |

The immutable builder chain is cheap (~0.8µs). Cost is `toSql()` + render (~90%
together). Dispatch/await/decode adds ~nothing — `#decodeResult` is a no-op
unless Temporal parsing is opted in, and physical→JS column names are resolved
at render time (`phys AS key`), so there is no per-row remapping.

## 2. The real overhead is unprepared statements

`.unsafe(query, args)` in `packages/pg/src/orm/postgres_js_pool.ts` does not use
a prepared statement (the pool's `prepare: true` only applies to tagged
templates). Timed against a real Postgres, 1000 serial point-selects, median
µs/query:

| postgres.js path                                         |   µs/query |        q/s |
| -------------------------------------------------------- | ---------: | ---------: |
| tagged template (prepared) — the benchmark's raw control |     48.2µs |     20,734 |
| **`.unsafe()` unprepared — Sisal today**                 | **83.5µs** | **11,969** |
| `.unsafe(…, { prepare: true })`                          | **40.5µs** | **24,678** |

The benchmark compared Sisal (unprepared) against a **prepared** raw control —
apples to oranges. The unprepared path pays ~35µs of parse+plan per query. With
`{ prepare: true }`, `.unsafe()` is **40.5µs — faster than the tagged-template
control** (it skips postgres.js's template parsing), roughly **2× Sisal's
current throughput**.

## 3. Fix

Thread the pool's existing `prepare` option into the `.unsafe()` call in
`postgres_js_pool.ts` so it is prepared on direct connections and stays
unprepared under PgBouncer/Neon transaction pooling (`prepare: false`):

```ts
const prepare = options.prepare ?? true;
// …
const result = await reserved.unsafe(query, args, { prepare });
```

This carries to `@sisal/neon` (it reuses the pg path). Caveat: prepared
statements are cached per distinct SQL text, so a workload that renders very
high-cardinality dynamic SQL (e.g. varying IN-list arity) grows the server-side
prepared set — the same trade-off tagged templates already make, and it is gated
by the same `prepare: false` escape hatch.

## Reproduce

```sh
deno run -A perf/orm_execute_profile.ts          # Sisal CPU decomposition
# Query-path probe: node prepare_probe.mjs in a consumer with postgres.js,
# DB_URL pointing at docker/compose.yaml's pg16.
```
