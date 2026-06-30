# 03 — Sessionization (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.7](../../docs/v0.7.0-roadmap.md) Workstream A (analytics
readiness) → [v0.11 `@sisal/analytics`](../../docs/v0.11.0-roadmap.md). This is
**window-function work** (it builds directly on
[02-window-analytics](02-window-analytics.md)) plus a cumulative-sum grouping
trick, so it is blocked on the same missing `over()` surface.

**Related runnable examples:**
[`neon-activity-vectors`](../neon-activity-vectors/README.md) (raw `post_events`
with `occurred_at` — the same event stream a session is cut from) and the
`*-rising-feed` examples.

## Product use case

Turn a flat stream of per-user `post_events` into **sessions**: consecutive
events by the same user collapse into one session, and a gap longer than (say)
30 minutes starts a new one. The output is "how many sessions, how long each,
how many events per session" — the basis for engagement and retention analytics.
The classic SQL pattern: `lag` to measure the gap to the previous event, a flag
when the gap exceeds the threshold, then a **cumulative sum of those flags** as
the session id.

## SQL shape to preserve

```sql
WITH gaps AS (
  SELECT user_id, occurred_at,
         occurred_at - lag(occurred_at) OVER (
           PARTITION BY user_id ORDER BY occurred_at
         ) AS since_prev
  FROM post_events
),
flagged AS (
  SELECT user_id, occurred_at,
         CASE WHEN since_prev IS NULL
                OR since_prev > interval '30 minutes'
              THEN 1 ELSE 0 END AS is_new_session
  FROM gaps
),
sessions AS (
  SELECT user_id, occurred_at,
         sum(is_new_session) OVER (
           PARTITION BY user_id ORDER BY occurred_at
         ) AS session_id
  FROM flagged
)
SELECT user_id, session_id,
       min(occurred_at)                       AS started_at,
       max(occurred_at)                       AS ended_at,
       count(*)                               AS event_count
FROM sessions
GROUP BY user_id, session_id;
```

## Required future Sisal primitives

- Everything from [02-window-analytics](02-window-analytics.md): `lag` and a
  **windowed `sum()` with an `ORDER BY`** (the cumulative running total is the
  crux — without it there is no portable session id).
- Interval comparison in a `CASE`/`filter` predicate (`since_prev > interval`) —
  interval math partially exists (`dateAdd`/`dateSub`/`dateBin`, v0.5) but the
  threshold comparison in a projection is not a first-class surface.
- Multi-CTE chaining into a final `GROUP BY` — `db.with(...)` exists; this stays
  SELECT-only here, so it is portable across the SQLite family.

## Dialect classification

| Capability                  | PostgreSQL | Neon | SQLite (modern) | libSQL | future MySQL (8+)    |
| --------------------------- | ---------- | ---- | --------------- | ------ | -------------------- |
| `lag` + running `sum` OVER  | engine ✅  | ✅   | engine ✅       | ✅     | engine ✅            |
| interval gap threshold      | ✅ native  | ✅   | ✅ (seconds)    | ✅     | ✅ (`TIMESTAMPDIFF`) |
| **Sisal builder (windows)** | ❌ none    | ❌   | ❌ none         | ❌     | ❌ none              |

## Portable / emulatable / dialect-native / fail-guarded

- **Portable (once windows exist):** the whole pattern is portable across every
  engine that has window functions — it is a pure analytics query, no upsert, no
  DDL.
- **Emulatable:** the gap/threshold differs by dialect (Postgres `interval`,
  SQLite `unixepoch` second-math, MySQL `TIMESTAMPDIFF`) — emulatable behind a
  portable duration abstraction.
- **Dialect-native:** none required.
- **Fail guarded → feature-matrix:** same window-function `❌` row as
  [02-window-analytics](02-window-analytics.md); sessionization adds no new
  dialect wall beyond windows + duration math.

## Non-goals

Not real-time sessionization, not a streaming windower, not attribution
modelling. A batch query over an events table that emits sessions — no more.

## Future acceptance criteria

- The three-CTE → `GROUP BY` pipeline renders through the builder on pg/neon and
  modern sqlite/libsql, using the v0.7 window surface and a portable duration
  threshold.
- A fixture stream with known gaps produces the exact expected session count and
  per-session boundaries on every engine.
- The duration-threshold abstraction is pinned per dialect (Postgres interval ↔
  SQLite seconds ↔ MySQL `TIMESTAMPDIFF`).
