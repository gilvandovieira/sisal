# `@sisal/pg` performance report: the `@db/postgres` parameterized-query stall

**Status:** root cause isolated; fix **prototyped and validated end-to-end**
(see §4①) — a postgres.js-backed pool injected through the public
`connect({ pool })` API takes Sisal's per-query time from **42.02 ms → 0.40 ms**
(~105×), with identical rows and working interactive transactions, **zero
changes to `@sisal/orm` or the executor**. **TL;DR:** `@sisal/pg` is ~**117×
slower per query than it should be**, and **none of it is Sisal**. The cost is
entirely in the underlying JSR driver `jsr:@db/postgres` (deno-postgres): a
_parameterized_ (`$1/$2`, extended-protocol) query takes **~42 ms**, while the
**same query** with inlined literals takes **0.3 ms** and the same parameterized
query on **postgres.js takes 0.36 ms**. The stable ~40 ms is the textbook **TCP
delayed-ACK / Nagle** signature. **Fix: give `@sisal/pg` a postgres.js-backed
driver** (or land a `TCP_NODELAY` / message-coalescing fix in deno-postgres).
Expected result: the ORM feed endpoint jumps from ~120 rps to postgres.js-class
(thousands of rps), with **zero changes to Sisal's query builder or executor** —
they're already optimal.

---

## 1. Impact (real app: a mobile social feed, Deno 2.9.0)

Swapping Drizzle → Sisal in a real feed endpoint
(`SELECT … FROM posts JOIN users WHERE status=$1 AND
status=$2 ORDER BY created_at DESC LIMIT 20`),
load-tested at concurrency 12, medians of 3 rounds:

| Stack (same DB, same query)                                |     rps |       p50 |
| ---------------------------------------------------------- | ------: | --------: |
| Drizzle (postgres.js)                                      |   5,550 |    2.0 ms |
| raw `@db/postgres`, **inlined literals** (simple protocol) |   3,001 |    3.7 ms |
| **Sisal (`@sisal/orm` + `@sisal/pg`)**                     | **120** | **90 ms** |
| Kysely compiler + `@db/postgres` (parameterized)           |      25 |    505 ms |

The two slow stacks (Sisal, Kysely) are _exactly_ the two that send `$1/$2`
**parameters through `@db/postgres`**. The fast ones either use postgres.js or
inline literals. That is the whole story.

> Memory, for context, is fine: Sisal warm RSS ~162 MB (lowest startup peak of
> all four, ~968 MB). This is purely a throughput problem.

## 2. Isolation proof (sequential, single connection — no pool contention)

Same query, four ways, 300 iterations each after 30 warm-ups, on the same local
Postgres 16:

| # | Path                                                      |          p50 |           vs Sisal |
| - | --------------------------------------------------------- | -----------: | -----------------: |
| A | Sisal **build only** (`.toSql()`, no DB)                  |  **0.02 ms** |    builder is free |
| B | **Sisal `.execute()`** (parameterized → `@db/postgres`)   | **42.03 ms** |                  — |
| C | raw `@db/postgres` **parameterized** (`{text, args}`)     | **42.02 ms** | **identical to B** |
| D | raw `@db/postgres` **inlined literals** (simple protocol) |  **0.29 ms** |        145× faster |
| E | **postgres.js** parameterized (same `$1/$2`)              |  **0.36 ms** |    **117× faster** |

**What this establishes:**

- **Sisal's query builder is free** (A = 0.02 ms).
- **Sisal's executor adds nothing**: B (42.03) == C (42.02). Sisal's per-query
  overhead over calling the raw driver is **~0.01 ms**. The
  `SisalPgExecutor.execute()` path (acquire → `queryObject(sql, params)` →
  release, plus a cheap float-coercion) is already optimal.
- **The cost is 100% `@db/postgres`'s parameterized/extended-protocol path**: 42
  ms (C) vs 0.29 ms for the identical query as a literal string (D).
- **It is not "parameterized queries are slow"** — postgres.js runs the _same_
  `$1/$2` query in 0.36 ms (E). It is specifically `@db/postgres`'s
  implementation.

## 3. Mechanism: TCP delayed-ACK / Nagle on the extended protocol

The ~42 ms is a fixed timer, not variable work:
`min≈1.0 ms, p50≈42 ms, p90≈42.4 ms` — extremely tight around **40 ms**, which
is the Linux TCP **delayed-ACK** default. The occasional ~1 ms `min` is when the
ACK happens to piggyback. This is the classic **Nagle's algorithm × delayed-ACK
deadlock**:

- The extended protocol is a message sequence: **Parse → Bind → Describe →
  Execute → Sync**.
- If the socket does **not** have `TCP_NODELAY` set, and the driver writes these
  as small separate segments without coalescing/flushing them as one payload,
  Nagle holds the last small segment waiting for an ACK of the previous one; the
  server withholds that ACK for its ~40 ms delayed-ACK timer → **~40 ms per
  query.**
- The **simple** query protocol sends the whole statement in one write → no
  stall (path D, 0.29 ms).
- **postgres.js** sets `TCP_NODELAY` and pipelines the extended-protocol
  messages → no stall (path E, 0.36 ms).

**Where to confirm in deno-postgres:** the TCP connection setup (does it call
`conn.setNoDelay(true)` on the `Deno.TcpConn`?) and the write/flush path around
the `Parse/Bind/Describe/Execute/Sync` message batch (are they flushed as one
buffer, or written individually before `Sync`?). Either missing `TCP_NODELAY` or
an un-coalesced flush produces exactly this signature.

## 4. Recommended fixes (ranked)

### ① Ship a postgres.js-backed driver for `@sisal/pg` — _primary, unblocks now_

`@sisal/pg`'s executor is already driver-agnostic: `resolvePgConnectionSource`
accepts a `pool` or `client` implementing the small `PgClient`/`PgPool`
interface (`queryObject(sql, params) → { rows, rowCount,
rowDescription }`).
Implement that interface over **`npm:postgres`** (postgres.js) and the 42 ms →
~0.4 ms with **no change to `@sisal/orm` or the executor**. Options:

- make it the default driver for `@sisal/pg`, or
- ship it as an opt-in (`connect({ url, driver: "postgres-js" })`) or a sibling
  package (`@sisal/pg-js`), keeping `@db/postgres` available for pure-JSR
  deployments that accept the perf cost.

**"But postgres.js is npm, and Sisal is JSR-native."** Two answers: (a)
`@sisal/neon` _already_ ships an npm driver (`@neon/serverless`), so an
npm-backed adapter is consistent with the project. (b) The historical reason to
avoid npm on Deno — the `--watch`/npm-compat memory tax — **no longer applies on
Deno 2.9**: a same-session re-baseline shows the old Drizzle "+530 MB/reload →
OOM" collapsed to ~130 MB warm / +17 MB per reload; postgres.js is pure-JS with
a trivial footprint. npm is no longer a memory liability here.

postgres.js is pure-JS (no native addon), runs on Deno/Node/Bun, pools,
pipelines, and sets `TCP_NODELAY` — a clean fit for a driver-neutral ORM.

**Prototype (validated 2026-06-30).** A ~70-line
`createPostgresJsPool(): PgPool` over `npm:postgres` (each `connect()` does
`sql.reserve()` → a `PgClient` whose `queryObject` calls
`reserved.unsafe(text,
args)` and maps `result.columns[].type → typeOid`;
`release()` → `reserved.release()`) injected via `connect({ pool })` against the
**published `jsr:@sisal/pg@0.5.0`**:

| Sisal `.execute()` over          |         p50 |
| -------------------------------- | ----------: |
| `jsr:@db/postgres` (default)     |    42.02 ms |
| **postgres.js pool (prototype)** | **0.40 ms** |

Identical rows/order to the default driver, and `db.transaction()` works over
the reserved connection (`begin…commit` stay pinned). So the executor's
per-`execute()` `pool.connect()/release()` maps cleanly onto
`sql.reserve()/release()`. Prototype + bench:
`doomscrollr/bench/jsr-bench/sisal-postgresjs-pool.ts` and
`sisal-pgjs-microbench.ts` (kept in the caller project, not this repo — it needs
no Sisal source change).

### ② Land the fix upstream in deno-postgres — _principled, keeps `@sisal/pg` pure-JSR_

File/patch deno-postgres to `setNoDelay(true)` on the connection and/or coalesce
the extended-protocol message batch into a single flush before `Sync`. This
fixes it for the whole Deno ecosystem and keeps `@sisal/pg` on a JSR-native
driver. Downside: not in your control / timeline; you could vendor a patched
fork in the interim.

### ③ Do **not** "fix" it by inlining literals

Reverting to simple-protocol by interpolating values into SQL would restore
speed but reintroduces SQL injection and breaks the typed-parameter contract.
Not acceptable. (It only appears in the table to isolate the protocol as the
variable.)

### Also check `@sisal/neon` and `@sisal/libsql`

`@sisal/neon` uses `@neon/serverless` (WebSocket) and `@sisal/libsql` uses the
Turso driver — different transports, so they likely don't share this stall, but
run the same micro-bench against each to confirm the extended-protocol path is
clean there.

## 5. Minimal reproduction (standalone, no app needed)

```ts
// deno run --allow-net --allow-env --allow-read --allow-ffi \
//   --minimum-dependency-age=0 repro.ts   (DATABASE_URL must point at any Postgres with a `posts` table,
//                                           or swap in `select 1` + a $1 param)
import { Client } from "jsr:@db/postgres";
import postgresJs from "npm:postgres@^3.4.7";

const url = Deno.env.get("DATABASE_URL")!;
const SQL = "select $1::text as a, $2::int as b"; // any parameterized query shows it
const N = 300, WARM = 30;
const p50 = (
  t: number[],
) => (t.sort((x, y) => x - y), t[Math.floor(t.length / 2)].toFixed(2));
const time = async (label: string, fn: () => Promise<unknown>) => {
  for (let i = 0; i < WARM; i++) await fn();
  const t: number[] = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  console.log(label.padEnd(34), "p50", p50(t), "ms");
};

const c = new Client(url);
await c.connect();
await time(
  "@db/postgres parameterized",
  () => c.queryObject({ text: SQL, args: ["x", 1] }),
);
await time(
  "@db/postgres literal (simple)",
  () => c.queryObject("select 'x'::text as a, 1::int as b"),
);
await c.end();

const sql = postgresJs(url, { max: 1 });
await time("postgres.js parameterized", () => sql.unsafe(SQL, ["x", 1]));
await sql.end();
// Expected: @db/postgres parameterized ≈ 40+ ms; the other two ≈ <1 ms.
```

The full ORM-level repro (paths A–E above) lives in the caller project at
`bench/jsr-bench/sisal-microbench.ts`.

## 6. Environment

- Deno **2.9.0**, Linux (CachyOS), 20-core i7-12700H.
- Local **Postgres 16** in Docker over loopback TCP (`localhost:5433`).
- `@sisal/orm` / `@sisal/pg` **0.5.0**, `jsr:@db/postgres` 0.19.5,
  `npm:postgres` 3.4.x.
- `@sisal/pg` default pool: `new Pool(url, poolSize ?? 5, lazy ?? true)`;
  executor: `packages/pg/orm/executor.ts`
  (`acquire → queryObject(sql, normalizeParams(params)) → release`).

---

**Bottom line:** the Sisal builder (0.02 ms) and executor (+0.01 ms) are already
fast. One driver change — `TCP_NODELAY` — stands between `@sisal/pg` and
postgres.js-class throughput.

---

## Addendum — full-stack benchmark (2026-06-30): prototype in a real feed server

The micro-bench (§2/§4①) measured a single `.execute()`. This confirms it in a
**real Hono feed server under concurrent load** (concurrency 12, medians of 3
rounds, Deno 2.9.0, local Postgres 16), against every other stack. The
postgres.js adapter is the same prototype, injected via `connect({ pool })`;
harness: `bench/jsr-bench/sisal-pgjs-feed.ts` + `sisal-vs-run.sh`.

| Stack                                  | warm RSS (med) | startup peak | post-load RSS | **/feed rps** |    **p50** | `--watch` +MB/reload |
| -------------------------------------- | -------------: | -----------: | ------------: | ------------: | ---------: | -------------------: |
| npm — Drizzle (postgres.js)            |            122 |        ~1555 |           232 |         5,445 |     2.0 ms |                  +15 |
| jsr — raw `@db/postgres` (literals)    |            179 |         ~955 |           237 |         2,888 |     3.8 ms |                  +60 |
| Kysely (`@db/postgres`, parameterized) |            130 |        ~1612 |           140 |            25 |     505 ms |                  +26 |
| **Sisal → `@db/postgres`** (before)    |            155 |         ~951 |           173 |       **120** |  **90 ms** |                  +62 |
| **Sisal → postgres.js** (after)        |            169 |         ~968 |           276 |     **6,774** | **1.6 ms** |                  +69 |

**Throughput: 120 → 6,774 rps (~56×), p50 90 ms → 1.6 ms.** The swap moves Sisal
from **last to first** — now _ahead of_ Drizzle (5,445 rps @ 2.0 ms; both ride
postgres.js, so it's a wash within noise). Correctness held (identical
rows/order) and interactive `db.transaction()` worked (the adapter reserves one
connection per `pool.connect()`).

**Memory: a small, acceptable cost.** Loading postgres.js lifts warm RSS 155 →
169 MB and post-load 173 → 276 MB — still mid-pack. Crucially, Sisal +
postgres.js **keeps the lowest-tier startup peak (~968 MB), like Sisal-default
and vs Drizzle/Kysely's ~1.6 GB** npm-compat transpile transient. `--watch`
+69/reload is in line with the other postgres.js/JSR-driver stacks and far below
the old 2.8.3 ceiling.

**Conclusion:** on Deno 2.9, `@sisal/pg` backed by postgres.js delivers
**Drizzle-class-or-better throughput + full Sisal ergonomics + competitive
memory + the lowest startup peak of any stack tested.** Recommendation ① (ship a
postgres.js driver) is validated end-to-end. Remaining upstream option ②
(`TCP_NODELAY` in deno-postgres) would additionally rescue the pure-JSR
`@db/postgres` path.

---

## Update — shipped in `@sisal/pg` v0.5.1 (2026-07-01)

Recommendation ① shipped: **`@sisal/pg` v0.5.1** carries a built-in postgres.js
driver, selected via `connect({ url, driver: "postgres-js" })` (postgres.js
lazily imported — `@db/postgres` stays the pure-JSR default; the release adds
bigint/date/timestamp decoders so rows are byte-identical across drivers). The
full 5-stack suite was re-run against the **published** `jsr:@sisal/pg@0.5.1`
via the official option (not the injected prototype); one run was discarded for
contention with concurrent Sisal-repo benchmarks, and this is the clean re-run:

| Stack (Deno 2.9.0, v0.5.1)              | warm RSS | startup peak | post-load | `/feed` rps |         p50 | `--watch` +MB/reload |
| --------------------------------------- | -------: | -----------: | --------: | ----------: | ----------: | -------------------: |
| npm — Drizzle (postgres.js)             |      136 |        ~1603 |       247 |       5,638 |      2.0 ms |                  +18 |
| jsr — raw `@db/postgres` (literals)     |      163 |         ~976 |       223 |       2,971 |      3.8 ms |                  +65 |
| Kysely (`@db/postgres`, parameterized)  |      129 |        ~1550 |       140 |          25 |      505 ms |                  +10 |
| Sisal → `@db/postgres` (v0.5.1 default) |      169 |         ~951 |       187 |         120 |       91 ms |                  +63 |
| **Sisal → postgres.js (v0.5.1)**        |      157 |         ~957 |       264 |   **6,655** | **1.65 ms** |                  +64 |

**The released driver reproduces the prototype: 6,655 rps @ 1.65 ms** (prototype
6,774 @ 1.6 ms) — top of the table, ahead of Drizzle (5,638 @ 2.0 ms), **~55×
over the default `@db/postgres` path** (120 @ 91 ms). Memory competitive (warm
157 MB, lowest startup peak ~957 MB). **Recommendation ① is shipped and
validated on the published package.** Option ② (`TCP_NODELAY` upstream in
deno-postgres) remains the way to also rescue the default pure-JSR path.
