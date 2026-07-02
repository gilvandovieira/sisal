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

Absolute microsecond timings are machine-dependent, so this page does not report
them — every figure below is **normalized**: a ratio between two things measured
on the same machine, in the same run, which cancels the hardware out. Run
`deno task bench` to see the raw numbers for your own machine.

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

| Operation                                |       Relative cost |
| ---------------------------------------- | ------------------: |
| Render a prepared query (AST → SQL)      |               ~0.4× |
| Build a simple query (`toSql`)           |               ~0.5× |
| Delete                                   |               ~0.7× |
| **Build + render a simple query**        |     **1.0×** (base) |
| Select                                   |                 ~1× |
| Insert (1 row, returning)                |                 ~1× |
| Update                                   |               ~1.5× |
| `and(...)` — 4 conditions                |                 ~3× |
| CTE / union / intersect + except²        | ~5× / ~3.5× / ~4.5× |
| Build + render a complex query¹          |                ~10× |
| `and(...)` — 32 conditions               |                ~16× |
| Insert (100 rows)                        |                ~30× |
| Schema snapshot — 1 / 3 / 12 tables      |  ~1.5× / ~3× / ~10× |
| Migration DDL — CREATE (3 tables)        |               ~2.5× |
| Migration DDL — additive diff (+1 table) |                 ~4× |

¹ A join + group + having + order query. ² Build + render a CTE (`WITH …`), a
two-select `UNION`, and a three-select `INTERSECT`/`EXCEPT` chain.

Microbenchmarks are noisy, so every figure here is **rounded to an order of
magnitude** — read them as "about the same," "a few ×," or "~10× / ~30×", not as
exact ratios. Re-run `deno task bench` and the absolute timings (and the small
ratios) will wobble; the magnitudes hold.

**Takeaways.**

- Most statements cost about the same as one simple query (~0.7–1.5×). A complex
  join/group/having query is ~10× a simple one; a 100-row bulk insert ~30×.
- For complex queries the **builder costs as much as or more than the
  renderer**: the immutable, clone-per-method builder chain is where the time
  goes, not the SQL string rendering.
- **Dialect is free.** Rendering the same AST for Postgres (`$1`, native
  `ILIKE`) vs SQLite (`?`, `ilike → like`) differs by only a few percent —
  within run-to-run noise, so the operator translation costs nothing measurable.
- Bulk insert, snapshot, and DDL costs scale **linearly** with table/row count.

> The migration-DDL path was made **~2× cheaper** by computing the schema diff
> once and deriving both the statements and the destructive-change list from it,
> instead of diffing twice. The additive-diff path is now bounded by a single
> diff.

---

## 2. Temporal serialization + parsing (Sisal)

Every query that binds or returns a date/time value runs through Sisal's own
temporal paths. Two database-free groups pin that cost:

- `sisal temporal params` — `serializeSqlValue(...)` for `Date` and each
  `Temporal.*` type (including arrays), plus `renderSql` for statements that
  bind them. This is the write-side cost of turning a temporal value into a
  bound parameter.
- `sisal temporal row parsing · N rows` — a fake `OrmDriver` returns rows shaped
  like database date/time text, swept across 1 / 100 / 1000 rows. `parse=false`
  is the baseline; `parse=true` adds Temporal decoding, so the ratio is the
  per-row cost Sisal pays to hand back `Temporal.*` values instead of strings —
  and it grows with row count, which is the signal worth watching.

Temporal is Sisal's model for SQL date/time because it matches the database
semantics: `date` is a calendar date, `time` is a wall-clock time, `timestamp`
is a local date-time, and `timestamptz` is an instant. (Benchmarks that timed
the raw `Date`/`Temporal` runtime APIs were dropped — Sisal cannot influence
them, so they carried no regression signal.)

## Honest framing

These benchmarks measure **CPU efficiency and headroom**, not end-to-end request
latency. In a real application the database and network dominate, so a large
edge in generation or mapping rarely moves the wall-clock time of a single
query. The gap matters when the per-query CPU is the constraint: large result
sets, tight loops building many statements, serverless cold paths where every
millisecond of compute is billed, and high-throughput services where ORM
overhead competes with real work for the event loop.

## Reproduce

```sh
deno task bench                 # the whole suite
```

The scenarios live in `benchmarks/scenarios/` — SQL generation
(`sql_generation.ts`), advanced-SQL constructs (`advanced_sql.ts`), the ORM
dispatch/read path (`fakedbproxy.ts`), migration workflow (`migrate_cli.ts`),
and temporal serialization/parsing (`temporal.ts`). The suite is network- and
engine-free: it runs entirely against the in-memory fake driver, so it needs no
database and no special permissions.
