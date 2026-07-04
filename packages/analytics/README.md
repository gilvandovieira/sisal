# @sisal/analytics

Typed analytical queries for [Sisal](https://jsr.io/@sisal) (v0.11 preview):
describe dimensions, aggregate metrics, and windowed metrics over rollup tables,
then render one parameterized SQL statement through `@sisal/core`.

```ts
import {
  bucket,
  descending,
  from,
  movingAvg,
  rank,
  sum,
} from "@sisal/analytics";

const rising = from(postHourlyStats)
  .dimensions({
    postId: postHourlyStats.columns.post_id,
    bucket: bucket("hour", postHourlyStats.columns.bucket),
  })
  .metrics({
    votes: sum(postHourlyStats.columns.votes),
    comments: sum(postHourlyStats.columns.comments),
  })
  .windows({
    voteMa6h: movingAvg("votes", {
      partitionBy: ["postId"],
      orderBy: ["bucket"],
      rows: 6,
    }),
    hourlyRank: rank({
      partitionBy: ["bucket"],
      orderBy: [descending("votes")],
    }),
  })
  .compareToPreviousWindow("votes")
  .orderBy(descending("voteMa6h"))
  .limit(50);

const { text, params } = rising.render({ dialect: "postgres" });
const rows = await rising.execute(db);
```

The result row is inferred from the query definition: dimension values,
aggregate metric nullability, and windowed metric values all become typed row
properties. `compareToPreviousWindow("votes")` adds `votesPrevious` and
`votesDelta` fields along the query's `bucket()` time axis.

The package is Postgres-first and rollup-first. It pairs with `@sisal/etl`: ETL
builds tables such as `post_hourly_stats`; analytics queries those prepared
tables for dashboards, feeds, and time series. Querying raw event streams is
allowed but can be expensive.

Execution is adapter-neutral. `execute(db)` accepts any object with a
`dialectIdentity` and `execute(Sql)` method, so `@sisal/analytics` does not
import adapters, database drivers, `@sisal/orm`, `@sisal/migrate`, or
`@sisal/etl`. Unsupported constructs are preflighted with `supportsQuery()` /
`assertQuerySupported()` and fail as `ANALYTICS_UNSUPPORTED_QUERY`, not as raw
engine errors.

Percentiles (`percentileCont` / `percentileDisc`) are experimental
Postgres-first helpers in this preview. They render ordered-set aggregates on
Postgres and are capability-gated elsewhere until variant-specific behavior is
probed and documented.
