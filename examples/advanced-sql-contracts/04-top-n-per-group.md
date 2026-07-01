# 04 — Top-N per group (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.7](../../docs/v0.7.0-roadmap.md) Workstream A (analytics
readiness — the `row_number()` window) →
[v0.11 `@sisal/analytics`](../../docs/v0.11.0-roadmap.md). **MySQL-portable in
principle** once [v0.7 Workstream B](../../docs/v0.7.0-roadmap.md) ships
`@sisal/mysql` (MySQL 8 has window functions). Window-function work, so it
shares the wall in [02-window-analytics](02-window-analytics.md).

**Related runnable examples:**
[`postgres-family-feed`](../postgres-family-feed/README.md) (ranked feeds — "top
posts" is "top-1 per ranking window"),
[`neon-activity-vectors`](../postgres-family-activity-vectors/README.md).

## Product use case

"The **top 3 posts per community** this week", "the **top 5 comments per
post**", "the **best-selling course per category**". The canonical solution is
`row_number() OVER (PARTITION BY group ORDER BY metric DESC)` filtered to
`rn <= N` — strictly better than the `LIMIT`-per-group correlated-subquery
hacks, and the shape every leaderboard reduces to.

## SQL shape to preserve

```sql
WITH ranked AS (
  SELECT community_id, post_id, score,
         row_number() OVER (
           PARTITION BY community_id ORDER BY score DESC, post_id
         ) AS rn
  FROM posts
)
SELECT community_id, post_id, score
FROM ranked
WHERE rn <= 3
ORDER BY community_id, rn;
```

## Required future Sisal primitives

- `rowNumber()` (and `rank`/`denseRank`) as window functions — from
  [02-window-analytics](02-window-analytics.md); **absent today**.
- `over({ partitionBy, orderBy })` — **absent today**.
- The outer `WHERE rn <= N` over a CTE — `db.with(...)` + `where` already exist,
  so once the window column is expressible this part is builder-native.

## Dialect classification

| Capability              | PostgreSQL | Neon | SQLite (modern) | libSQL | future MySQL (8+) |
| ----------------------- | ---------- | ---- | --------------- | ------ | ----------------- |
| `row_number()` / `OVER` | engine ✅  | ✅   | engine ✅       | ✅     | engine ✅         |
| filter on window col    | engine ✅  | ✅   | engine ✅       | ✅     | engine ✅         |
| **Sisal builder**       | ❌ none    | ❌   | ❌ none         | ❌     | ❌ none           |

MySQL 8 supports `row_number()`, so this contract is one of the **most
portable** window examples for the future fifth dialect — but **MySQL 5.7 /
older MariaDB have no window functions**, which is a genuine capability split to
record (see [12-mysql-compatibility](12-mysql-compatibility.md)).

## Portable / emulatable / dialect-native / fail-guarded

- **Portable (once windows exist):** identical SQL on pg/neon/modern-sqlite/
  libsql/MySQL 8.
- **Emulatable:** on a window-less engine (MySQL 5.7), top-N degrades to a
  correlated `LIMIT` subquery or session variables — ugly and slow; the contract
  prefers to **fail guarded** there rather than ship a trap.
- **Dialect-native:** none.
- **Fail guarded → feature-matrix:** an engine without `row_number()` gets a
  `❌` window-function cell in
  [`docs/feature-matrix.md`](../../docs/feature-matrix.md); the analytics IR
  throws a typed guard instead of silently emitting a slow fallback.

## Non-goals

Not generalized leaderboards-as-a-service, not materialized top-N caches, not
ties-resolution policy beyond a deterministic `ORDER BY` tiebreaker.

## Future acceptance criteria

- `row_number() OVER (PARTITION BY … ORDER BY …)` + `WHERE rn <= N` renders
  through the builder on every window-capable engine, result-typed.
- A fixture with known per-group ordering returns exactly the expected N rows
  per group, with the tiebreaker honored, on each engine.
- A window-less target (if `@sisal/mysql` supports older MySQL) throws a typed
  guard and is `❌` in the matrix — verified, not assumed.
