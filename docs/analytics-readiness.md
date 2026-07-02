---
title: Analytics Readiness
---

# Analytics-readiness report — workstream A, complete (v0.7.0)

**Date:** 2026-07-01 · **Status:** A1-A4 🟢 · **Scope:** investigation and type
prototype only. No `@sisal/analytics` package, renderer, runtime, dashboard
helper, public export, or generated feature-matrix claim ships in v0.7.

## Baseline

The current compile target for downstream packages is the existing core SQL
fragment layer:

- `Sql` / `SqlChunk` fragments render per dialect with bound parameters.
- `SqlExpression<T>` carries result type information for select projections.
- `Condition` and the predicate helpers already produce reusable filters.
- `dialectSql(...)` selects a dialect rendering for one logical expression.
- `dialectGuard(...)` fails typed when a dialect cannot express a construct.
- Select projections already infer row keys from `{ alias: expression }`.

There is **no transformable relational AST** today. Core exposes a renderable
fragment/expression IR, not an optimizer or query-rewriting tree. Analytics can
build parameterized SQL on top of that layer, but predicate pushdown, relational
rewrites, and plan optimization remain v0.8+ core questions.

There is also **no window-function builder today**: no `OVER`, `PARTITION BY`,
frame builder, ranking helpers, `lag`/`lead`, or percentile helpers. The
advanced SQL contracts preserve those target shapes until the surface ships.

## Answers

### Can analytics be a separate package?

Yes. The future `@sisal/analytics` package can compile its own
metric/dimension/window model into core fragments and ordinary select
projections. It does not need the OLTP query builder to depend on analytics, and
it should not put dashboard-oriented concepts into `@sisal/orm`.

The dependency direction stays:

```text
@sisal/core fragments/types  <-  @sisal/analytics IR/API
                              <-  adapters execute rendered SQL
```

In the current repository shape, that means building against the
`@sisal/orm/core` subpath until the v0.8 `@sisal/core` extraction happens.

### What analytical IR is needed?

The minimal future IR is a small query description, not a grand relational
algebra:

```ts
interface AnalyticalQueryIr {
  source: AnalyticalSource;
  joins: readonly AnalyticalJoin[];
  filters: readonly Condition[];
  dimensions: Readonly<Record<string, DimensionIr>>;
  metrics: Readonly<Record<string, MetricIr>>;
  windows: Readonly<Record<string, WindowIr>>;
  derivedFields: Readonly<Record<string, DerivedFieldIr>>;
  order: readonly AnalyticalOrderTerm[];
  limit?: number;
  executionPreference?: "primary" | "postgres" | "duckdb-later";
}
```

Where:

- `source` is a table, rollup table, or subquery.
- `joins` are dimension joins.
- `filters` reuse core predicates.
- `dimensions` are group keys, including time buckets.
- `metrics` are typed aggregate or window expressions.
- `windows` are reusable partition/order/frame specs.
- `derivedFields` are computed from dimensions or metrics.
- `order` and `limit` are final result controls.
- `executionPreference` is a pushdown hint, not a second renderer.

The IR should stay close to the product-shaped examples: feeds, rollups,
funnels, cohorts, and dashboards.

### What belongs in core vs analytics?

**Decision (A3):** a future minimal `over()` belongs in core because
`OVER (...)` is generic SQL expression grammar. It should compose with
`SqlExpression<T>` anywhere a normal expression can appear, including ordinary
ORM select projections.

v0.7 does **not** ship `over()` or any window helper. The decision is recorded
now so v0.11 can add the analytics package without forcing the OLTP builder to
learn analytics concepts.

Future core-owned surface:

```ts
interface WindowSpec {
  readonly partitionBy?: readonly unknown[];
  readonly orderBy?: readonly unknown[];
  readonly frame?: WindowFrame;
}

type WindowFrame =
  | {
    readonly unit: "rows";
    readonly start: FrameBound;
    readonly end: FrameBound;
  }
  | {
    readonly unit: "range";
    readonly start: FrameBound;
    readonly end: FrameBound;
  };

function over<T>(
  expression: SqlExpression<T>,
  spec: WindowSpec,
): SqlExpression<T>;
```

Future analytics-owned surface:

- `metric(...)` and `dimension(...)` descriptors.
- Named windows.
- Moving-average helpers.
- Ranking helpers.
- `lag` / `lead` helpers.
- Period comparison.
- Percentile helpers.
- Rollup-table querying.

The ORM builders stay unaware beyond what they already do: accept typed SQL
expressions in projections.

### Can result types be inferred?

Yes. A type-only prototype in
[`packages/orm/analytics_result_inference_test.ts`](../packages/orm/analytics_result_inference_test.ts)
shows that a map of dimensions, metrics, and derived fields can infer an exact
readonly result row:

```ts
type Row = InferAnalyticsRow<typeof risingSpec>;
// {
//   readonly postId: string;
//   readonly communityId: string;
//   readonly bucket: string;
//   readonly viewCount: number;
//   readonly voteTotal: number | null;
//   readonly voteMovingAverage6h: number | null;
//   readonly hourRank: number;
//   readonly risingScore: number;
//   readonly voteDelta: number | null;
// }
```

The important finding is that the row type can be derived from descriptor maps
without a runtime package. The future package can preserve this shape while
adding real validation and rendering.

### Which features are portable?

Portability must be explicit and capability-gated. Most basic analytics can be
portable across PostgreSQL, Neon, modern SQLite, libSQL, and MySQL 8+/compatible
MariaDB. Percentiles, array/vector projection, and some window frame semantics
need stricter classification.

Unsupported analytical features must fail with typed capability errors, not raw
engine errors. The generated feature matrix is unchanged in v0.7 because none of
these analytics features are shipped or integration-backed yet.

## Compilation Sketch

The future analytics compiler can lower an IR into the existing core shapes:

1. Resolve `source` and `joins` into a select builder source.
2. Convert `filters` into `where(and(...))`.
3. Convert `dimensions` into projection entries and `groupBy(...)` entries.
4. Convert aggregate `metrics` into projection entries.
5. Convert windowed `metrics` into `over(metric.expression, windowSpec)` once
   the core seam exists.
6. Convert `derivedFields` into projection entries that reference projected
   metric expressions or wrap a subquery if the dialect cannot reuse aliases in
   the same projection.
7. Attach `order` and `limit`.
8. Render with the normal dialect renderer.

Example lowering target:

```ts
db.select({
  postId: stats.columns.postId,
  bucket: stats.columns.bucket,
  votes: sum(stats.columns.votes),
  voteMa6h: over(avg(stats.columns.votes), {
    partitionBy: [stats.columns.postId],
    orderBy: [stats.columns.bucket],
    frame: {
      unit: "rows",
      start: { preceding: 5 },
      end: "currentRow",
    },
  }),
}).from(stats)
  .where(gte(stats.columns.bucket, from))
  .groupBy(stats.columns.postId, stats.columns.bucket);
```

The fragment IR remains the renderer boundary. Analytics adds typed descriptors
and capability checks above it.

## Feed Boundaries

- **`/new` feed:** ORM territory. It is a keyset `SELECT` over posts ordered by
  creation time. No analytics IR needed.
- **`/hot` feed:** reads a cached/stored score, as in the hot-feed example. It
  should not recompute a live analytical score on every request.
- **`/rising` feed:** canonical analytics target. It benefits from recent
  rollups/events, moving-window scores, deltas, and per-community rank.
- **Dashboard metrics:** should query prepared rollups from future `@sisal/etl`
  output whenever possible, not repeatedly scan raw events.

## `/rising` Walkthrough

Assume an ETL job maintains a rollup table:

```sql
post_hourly_stats(
  post_id,
  community_id,
  bucket,
  views,
  votes,
  comments,
  engagement_score
)
```

Pseudo analytics IR:

```ts
analyticsQuery({
  source: rollup("post_hourly_stats"),
  filters: [gte("bucket", dateSub(now(), { hours: 24 }))],
  dimensions: {
    postId: dimension("post_id"),
    communityId: dimension("community_id"),
    bucket: dimension("bucket"),
  },
  metrics: {
    votes: metric(sum("votes")),
    comments: metric(sum("comments")),
    voteMa6h: metric(movingAverage("votes", {
      partitionBy: ["post_id"],
      orderBy: ["bucket"],
      rows: { preceding: 5, current: true },
    })),
    voteDelta: metric(delta("votes", {
      partitionBy: ["post_id"],
      orderBy: ["bucket"],
    })),
    hourRank: metric(rank({
      partitionBy: ["community_id", "bucket"],
      orderBy: [desc("engagement_score")],
    })),
  },
  derivedFields: {
    risingScore: derived("voteMa6h * 2 + voteDelta + comments * 0.5"),
  },
  order: [desc("risingScore")],
  limit: 50,
  executionPreference: "primary",
});
```

Target SQL shape:

```sql
SELECT
  post_id,
  community_id,
  bucket,
  sum(votes) AS votes,
  sum(comments) AS comments,
  avg(votes) OVER (
    PARTITION BY post_id
    ORDER BY bucket
    ROWS BETWEEN 5 PRECEDING AND CURRENT ROW
  ) AS vote_ma_6h,
  votes - lag(votes) OVER (
    PARTITION BY post_id
    ORDER BY bucket
  ) AS vote_delta,
  rank() OVER (
    PARTITION BY community_id, bucket
    ORDER BY engagement_score DESC
  ) AS hour_rank
FROM post_hourly_stats
WHERE bucket >= ?
GROUP BY post_id, community_id, bucket
ORDER BY rising_score DESC
LIMIT ?;
```

Two implementation details stay future work:

- Some dialects require wrapping the projection before ordering by a derived
  alias such as `rising_score`.
- The windowed expressions need the future core `over()` seam.

## Portability Classification

Legend: **portable** = same concept renders cleanly; **degraded** = works with
value-shape or syntax caveats; **emulated** = different SQL with equal
semantics; **Postgres-first** = design around PostgreSQL first; **fail guarded**
= no acceptable equivalent, so throw typed.

| Feature                                      | PostgreSQL                                | Neon                    | SQLite                                    | libSQL                                    | MySQL/MariaDB future adapter                         |
| -------------------------------------------- | ----------------------------------------- | ----------------------- | ----------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Group-by dimensions                          | portable                                  | portable                | portable                                  | portable                                  | portable                                             |
| Conditional aggregates                       | portable (`FILTER`)                       | portable (`FILTER`)     | portable (`FILTER`)                       | portable (`FILTER`)                       | emulated (`CASE WHEN`)                               |
| Time buckets                                 | portable (`date_trunc`)                   | portable (`date_trunc`) | degraded (`strftime` text)                | degraded (`strftime` text)                | emulated (`DATE_FORMAT`/timestamp funcs)             |
| Fixed-width buckets                          | portable                                  | portable                | degraded (`unixepoch` text result)        | degraded (`unixepoch` text result)        | emulated (`UNIX_TIMESTAMP`/`FROM_UNIXTIME`)          |
| Basic `OVER (PARTITION BY ... ORDER BY ...)` | portable                                  | portable                | portable on modern SQLite                 | portable on modern libSQL                 | portable on MySQL 8+/MariaDB window-capable versions |
| `ROWS BETWEEN` frames                        | portable                                  | portable                | portable on modern SQLite                 | portable on modern libSQL                 | portable on MySQL 8+/MariaDB window-capable versions |
| `RANGE` frames                               | portable                                  | portable                | degraded; capability-check frame modes    | degraded; capability-check frame modes    | degraded; capability-check frame modes               |
| `row_number` / `rank` / `dense_rank`         | portable                                  | portable                | portable on modern SQLite                 | portable on modern libSQL                 | portable on MySQL 8+/MariaDB window-capable versions |
| `lag` / `lead`                               | portable                                  | portable                | portable on modern SQLite                 | portable on modern libSQL                 | portable on MySQL 8+/MariaDB window-capable versions |
| Moving averages                              | portable via windowed aggregates          | portable                | portable with frame checks                | portable with frame checks                | portable with version/capability checks              |
| Period comparisons                           | portable via self-join or `lag`           | portable                | emulated with date math differences       | emulated with date math differences       | emulated with `TIMESTAMPDIFF`/date funcs             |
| `first_value` cohort normalization           | portable                                  | portable                | portable on modern SQLite                 | portable on modern libSQL                 | portable on MySQL 8+/MariaDB window-capable versions |
| Percentiles                                  | Postgres-first (`percentile_cont`/`disc`) | Postgres-first          | fail guarded or approximated later        | fail guarded or approximated later        | degraded/variant-specific; guard until probed        |
| Duration/gap thresholds                      | portable intervals                        | portable intervals      | emulated with seconds math                | emulated with seconds math                | emulated with `TIMESTAMPDIFF`                        |
| Rollup-table querying                        | portable                                  | portable                | portable                                  | portable                                  | portable                                             |
| Array/vector projection                      | Postgres-first (`ARRAY[...]`)             | Postgres-first          | emulated with JSON arrays or fail guarded | emulated with JSON arrays or fail guarded | emulated with JSON or fail guarded                   |

## Non-Goals Confirmed

- No `@sisal/analytics` package in v0.7.
- No public analytics export from `@sisal/orm`.
- No renderer integration for windows.
- No dashboard helper.
- No ETL runtime.
- No generated feature-matrix rows for unshipped analytics features.
