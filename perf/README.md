# `perf/` — real-database latency benchmarks

Opt-in, real-Postgres latency probes that keep the `@sisal/pg` per-query cost
honest, pin the underlying-driver stall, and measure the validated fix. Full
write-up in [`PG_ADAPTER_PERF_REPORT.md`](./PG_ADAPTER_PERF_REPORT.md).

Like the `integration/` suites, these require a live database and are **gated
behind `DATABASE_URL`**, so they stay out of the network-free `deno task test`.

## Why this exists

Swapping a real app onto `@sisal/pg` regressed a feed endpoint from thousands of
rps to ~120 rps. The cost is **not** Sisal: `jsr:@db/postgres` writes the
extended-protocol messages (Parse → Bind → Describe → Execute → Sync) as
separate, un-coalesced TCP segments on a socket that never gets `TCP_NODELAY`,
tripping the classic **Nagle × delayed-ACK** deadlock — ~40 ms per parameterized
round-trip. The same query inlined (simple protocol) or run through
`postgres.js` is ~0.1 ms.

Confirmed in the driver source: `connection.ts` calls `Deno.connect()` with no
`setNoDelay(true)`, and `#preparedQuery` issues five separate awaited
`write()`s, while `#simpleQuery` issues one.

**The fix (validated):** `@sisal/pg`'s executor is driver-agnostic, so injecting
a postgres.js-backed pool through the public `connect({ pool })` API drops
per-query latency ~100× — **with no `@sisal/orm`/executor change**. These
benchmarks make both the regression and the fix measurable, and guard against
the regression silently coming back (or silently masking a Sisal-side one).

## Files

| File                        | What it is                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `latency.ts`                | Pure timing + table utilities (percentiles, `measure`, table formatting). No DB/net/FFI.                    |
| `postgres_js_pool.ts`       | A postgres.js-backed `PgPool` adapter (the fix), so the probe can measure Sisal-over-postgres.js. Dev-only. |
| `pg_driver_latency.ts`      | The probe: times the same query six ways against a real Postgres and prints a verdict. Exports the runner.  |
| `pg_driver_latency_test.ts` | Gated guard test — asserts the Sisal-side invariants and characterizes the driver stall.                    |

## The six paths

Same query (`select $1::text, $2::int` — no schema, runs against any Postgres):

| id              | What it measures                                                                       |
| --------------- | -------------------------------------------------------------------------------------- |
| `sisal-render`  | Build + render the query, **no database** — builder overhead.                          |
| `sisal-execute` | `@sisal/pg` `db.execute(...)` over the default `@db/postgres` driver.                  |
| `driver-param`  | Raw `@db/postgres` parameterized (`{ text, args }`).                                   |
| `driver-inline` | Raw `@db/postgres` inlined literals (simple protocol).                                 |
| `pgjs-param`    | `postgres.js` parameterized — fast reference (skipped if npm is unavailable).          |
| `sisal-pgjs`    | `@sisal/pg` `db.execute(...)` over a postgres.js pool — **the fix** (skipped w/o npm). |

The invariants: `sisal-render` is ~free, `sisal-execute` tracks `driver-param`
(Sisal adds nothing over whatever driver it is wired to),
`driver-param ≫
driver-inline` is the driver stall, and `sisal-pgjs` collapses
onto `pgjs-param` — the fix, through Sisal's real executor, adds nothing over
postgres.js itself. Because `sisal-execute` reflects whichever driver
`@sisal/pg` is wired to, **the same probe measures an alternate driver for
free**.

## Running

```sh
# Bring up a Postgres (the repo's compose maps 16/17/18 to 55416/55417/55418):
docker compose -f docker/compose.yaml up -d pg16

# Standalone probe (prints the table + verdict):
DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal deno task perf:pg

# Guard test (warns on the stall, passes):
DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal deno task perf:pg:guard
```

`deno task perf:pg` runs with `--no-lock` on purpose: the optional `postgres.js`
paths are resolved at runtime, and locking `postgres` would pull it into the
workspace graph and re-resolve the benchmarks' `drizzle-orm` pin. The only
committed lock entry these benchmarks add is `jsr:@db/postgres` (used by the
type-checked probe).

Environment knobs:

| Var                 | Effect                                                            | Default |
| ------------------- | ----------------------------------------------------------------- | ------- |
| `DATABASE_URL`      | Postgres to hit; **absent → everything is skipped**.              | —       |
| `SISAL_PERF_ITERS`  | Timed iterations (standalone probe).                              | `200`   |
| `SISAL_PERF_WARMUP` | Warm-up iterations (standalone probe).                            | `25`    |
| `SISAL_PERF_STRICT` | `1` turns the guard's stall characterization into a hard failure. | off     |

## Reading the output

```
path                                 n    min    p50    p90    p99   mean  vs fastest
-------------------------------------------------------------------------------------
sisal render (no db)               100   0.00   0.00   0.00   0.01   0.00        1.0×
@db/postgres inlined (simple)      100   0.04   0.05   0.15   0.25   0.07         27×
postgres.js parameterized          100   0.07   0.10   0.21   0.47   0.14         52×
sisal execute → postgres.js (fix)  100   0.08   0.10   0.21   0.43   0.14         54×
@db/postgres parameterized         100  40.63  41.03  41.68  42.26  41.14      21631×
sisal execute → @db/postgres       100  40.60  41.24  42.05  42.32  41.39      21741×

overhead: sisal execute p50 41.24 ms vs raw driver 41.03 ms → +0.21 ms of Sisal
driver:   parameterized 41.03 ms vs simple-protocol 0.05 ms → 804×
FIX:      sisal over postgres.js p50 0.10 ms → 403× faster than sisal over @db/postgres
          (+0.00 ms over raw postgres.js — Sisal stays thin over the fast driver too)
```

- **`sisal execute` ≈ `driver-param`** (here: +0.21 ms) → Sisal is not the cost.
  If this gap grows, a Sisal regression landed — investigate.
- **`driver-param` ≫ `driver-inline`/`pgjs-param`** → the driver stall is
  present. Expected today; an upstream `@db/postgres` bug, not a Sisal one. The
  tight clustering around ~40 ms is the delayed-ACK timer.
- **`sisal-pgjs` ≈ `pgjs-param`** (here: +0.00 ms, 403× faster than the default
  path) → the fix works through Sisal's real executor.

Once `@sisal/pg` ships the postgres.js-backed driver as default (or upstream
deno-postgres sets `TCP_NODELAY`), `sisal-execute` and `driver-param` collapse
toward the `postgres.js` reference. Flip `SISAL_PERF_STRICT=1` in CI at that
point to keep parameterized latency low.
