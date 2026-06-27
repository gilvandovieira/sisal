---
title: Benchmarks
---

# Benchmarks

Sisal benchmarks measure the work the **library** does — building SQL, rendering
it, and turning driver rows into typed results — in isolation from the database
and the network. A query's wall-clock time is dominated by the TCP roundtrip and
the engine; those are outside Sisal's control and identical for any client. What
Sisal _can_ control is the CPU it spends on each query, and that is what these
benchmarks pin down.

- **Harness:** `Deno.bench` via `benchmarks/`, run with `deno task bench`.
- **Comparison target:** Drizzle ORM 0.45.2 (the version pinned by the
  [Drizzle parity matrix](drizzle-parity.html)).

Absolute microsecond timings are machine-dependent, so this page does not report
them — every figure below is **normalized**: a ratio between two things measured
on the same machine, in the same run, which cancels the hardware out. Run
`deno task bench` to see the raw numbers for your own machine.

> **Drizzle runs through Deno's `npm:` compatibility layer**
> (`npm:drizzle-orm@0.45.2`), since Sisal is a Deno-native project and Drizzle
> ships as an npm package. That interop mainly affects module loading rather
> than steady-state compute — the query building and row mapping run as ordinary
> JavaScript on V8 — but a native Node or Bun run could differ. The ratios below
> are specific to running Drizzle under Deno's npm compatibility.

## What is and isn't measured

| Measured                                       | Excluded                  |
| ---------------------------------------------- | ------------------------- |
| Query building (immutable builders → AST)      | TCP / socket roundtrip    |
| Rendering to dialect SQL + bound params        | Database engine execution |
| Schema snapshot + migration DDL generation     | Disk / WAL / fsync        |
| Dispatch + result-row mapping to typed objects | Connection setup / TLS    |

The database is replaced by an in-memory **fake driver**
(`benchmarks/fakedbproxy.ts`) with zero latency that returns canned rows. It
implements the same `OrmDriver` / executor shapes the real adapters accept, so
the full ORM path runs unchanged — minus the wire.

---

## 1. Relative generation cost (Sisal)

Pure, synchronous generation: build the statement and render it to
`{ text, params }`, no driver and no `await`. Costs are expressed as a multiple
of **one simple query** — building and rendering a single parameterized
`SELECT … WHERE id = ?` (the baseline, `1.0×`).

| Operation                                |     Relative cost |
| ---------------------------------------- | ----------------: |
| Render a prepared query (AST → SQL)      |              0.4× |
| Build a simple query (`toSql`)           |              0.5× |
| Delete                                   |              0.7× |
| **Build + render a simple query**        |   **1.0×** (base) |
| Select                                   |              1.1× |
| Insert (1 row, returning)                |              1.3× |
| Update                                   |              1.5× |
| `and(...)` — 4 conditions                |              2.8× |
| Build + render a complex query¹          |             10.5× |
| `and(...)` — 32 conditions               |             16.4× |
| Insert (100 rows)                        |               31× |
| Schema snapshot — 1 / 3 / 12 tables      | 1.3× / 2.7× / 10× |
| Migration DDL — CREATE (3 tables)        |              2.1× |
| Migration DDL — additive diff (+1 table) |              3.6× |

¹ A join + group + having + order query.

**Takeaways.**

- Most statements cost about the same as one simple query (~0.7–1.5×). A complex
  join/group/having query is ~10× a simple one; a 100-row bulk insert ~30×.
- For complex queries the **builder costs as much as or more than the
  renderer**: the immutable, clone-per-method builder chain is where the time
  goes, not the SQL string rendering.
- **Dialect is free.** Rendering the same AST for Postgres (`$1`, native
  `ILIKE`) vs SQLite (`?`, `ilike → like`) differs by ~2% — the operator
  translation costs nothing measurable.
- Bulk insert, snapshot, and DDL costs scale **linearly** with table/row count.

> The migration-DDL path was made **~2× cheaper** by computing the schema diff
> once and deriving both the statements and the destructive-change list from it,
> instead of diffing twice. The additive-diff path is now bounded by a single
> diff.

---

## 2. SQL generation — Sisal vs Drizzle

Same query, same payload, both **built and rendered** to parameterized SQL:
Drizzle's `query.toSQL()` vs Sisal's `builder.toSql()` +
`renderSql({ dialect })`. The two dialects cover all four Sisal engines:
Postgres backs `@sisal/pg` and `@sisal/neon`; SQLite backs `@sisal/sqlite` and
`@sisal/libsql`.

| Operation             | Postgres — Sisal vs Drizzle | SQLite — Sisal vs Drizzle |
| --------------------- | :-------------------------: | :-----------------------: |
| simple select         |         2.1× faster         |        2.1× faster        |
| filtered select       |         2.7× faster         |        2.5× faster        |
| insert + returning    |         5.8× faster         |        4.4× faster        |
| bulk insert (50 rows) |        10.8× faster         |        4.8× faster        |
| update                |         4.8× faster         |        3.5× faster        |
| delete                |         3.7× faster         |        3.2× faster        |

**Takeaways.**

- Sisal generates SQL **~2×–11× faster** than Drizzle across every operation and
  both dialects.
- The widest gap is **Postgres bulk insert** — Drizzle's per-row parameter
  encoding for the pg dialect is its costliest step, and it compounds with row
  count. SQLite's lighter value encoding narrows the gap.
- **Writes beat reads in margin** — insert/update/delete show the largest gaps;
  selects are closest (~2–2.7×) because both libraries spend their time
  enumerating the same column projections.

---

## 3. Execution + result mapping — Sisal vs Drizzle

The other half of a query's cost is the **read path**: dispatch the statement
and turn the driver's raw rows into typed result objects. The database is the
zero-latency fake returning identical canned rows, so the only thing timed is
each ORM's dispatch + row mapping. Row count is the stressor.

| Result size | Postgres — Sisal vs Drizzle | SQLite — Sisal vs Drizzle |
| ----------- | :-------------------------: | :-----------------------: |
| 1 row       |         2.1× faster         |        2.1× faster        |
| 100 rows    |         4.8× faster         |        4.6× faster        |
| 1000 rows   |        14.9× faster         |       15.6× faster        |

Per row, Drizzle's mapping costs roughly **26× as much as Sisal's**.

**Takeaways.**

- The advantage **widens with result size** — ~2× at one row, ~15× at a thousand
  — because mapping cost is per row, and Sisal's per-row cost is far lower.
- Sisal's read path adds almost nothing per row: its `OrmDriver` contract hands
  back name-keyed row objects (a real adapter builds those in native driver
  code), so there is little left to do in JS. Drizzle reconstructs each row from
  positional values and coerces every column in JS.

> **Fairness note.** The two ORMs are measured from their _own_ driver
> boundaries, which differ by design — Sisal's returns named row objects,
> Drizzle's proxy returns positional arrays it maps to fields. Part of the gap
> is therefore _where_ column-naming happens, not pure overhead. These are the
> realistic per-query read costs of each library, not an isolated "mapping only"
> microbenchmark.

---

## Honest framing

These benchmarks measure **CPU efficiency and headroom**, not end-to-end request
latency. In a real application the database and network dominate, so a 10× edge
in generation or mapping rarely moves the wall-clock time of a single query. The
gap matters when the per-query CPU is the constraint: large result sets, tight
loops building many statements, serverless cold paths where every millisecond of
compute is billed, and high-throughput services where ORM overhead competes with
real work for the event loop.

## Reproduce

```sh
deno task bench                 # the whole suite
```

The generation, Drizzle generation, and Drizzle execution scenarios live in
`benchmarks/scenarios/{sql_generation,vs_drizzle,vs_drizzle_execute}.ts`. The
suite is network- and engine-free: it runs entirely against the in-memory fake
driver, so it needs no database and no special permissions beyond `--allow-read`
(plus `--allow-run=deno` for the migration-CLI scenarios).
