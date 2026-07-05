/**
 * PostgreSQL-**family** analytics example for Sisal `@sisal/analytics`.
 *
 * `@sisal/analytics` is the read side of the ETL story: describe **metrics ×
 * dimensions × windows** as typed descriptor maps over a rollup table and get
 * back one correct, parameterized SQL statement plus a result-row type inferred
 * from the definition. It pairs with `@sisal/etl` — the
 * [`postgres-family-etl-cron`](../postgres-family-etl-cron/README.md) example
 * folds raw `post_events` into the same `post_hourly_stats` rollup this example
 * reads.
 *
 * With zero setup it renders every query to SQL (`render`) and preflights each
 * with `supportsQuery`, so you can read exactly what analytics compiles without
 * a database. With `DATABASE_URL` set it creates the rollup table (additive
 * DDL), seeds a small demo rollup idempotently, and `execute`s the queries.
 *
 * ```sh
 * # dry-run: render + capability-check every query (no database):
 * deno run --allow-read examples/postgres-family-analytics/mod.ts
 * # live: also execute against a scratch Postgres:
 * DATABASE_URL=postgres://... \
 *   deno run --allow-env --allow-net --allow-read \
 *   examples/postgres-family-analytics/mod.ts
 * ```
 *
 * @module
 */

import { columns, createSchemaSnapshot, defineTable } from "@sisal/orm";
import {
  bucket,
  countDistinct,
  descending,
  from,
  max,
  movingAvg,
  rank,
  sum,
  supportsQuery,
} from "@sisal/analytics";
import { connect, type PgDatabase } from "@sisal/pg";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

// The rollup the ETL example writes. camelCase keys map to the same snake_case
// physical columns (`postId` → `post_id`), so this reads the exact table
// `postgres-family-etl-cron` produces. bigint reads back as string on pg.
const postHourlyStats = defineTable("post_hourly_stats", {
  postId: columns.bigint().notNull(),
  communityId: columns.text().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagementScore: columns.doublePrecision().notNull(),
});

const p = postHourlyStats.columns;

// ── The queries ────────────────────────────────────────────────────────────

/** Engagement over time: hourly totals for the whole feed, with the
 * period-over-period view delta. `countDistinct` counts active posts/hour. */
const engagementOverTime = from(postHourlyStats)
  .dimensions({ hour: bucket("hour", p.bucket) })
  .metrics({
    views: sum(p.views),
    votes: sum(p.votes),
    comments: sum(p.comments),
    activePosts: countDistinct(p.postId),
  })
  .compareToPreviousWindow("views")
  .orderBy("hour");

/** Rising feed: per-post velocity (6h moving average of votes), the rank of a
 * post within its community for each hour, and the previous-window vote delta.
 * This is the analytics counterpart of the hand-written `/rising` feed. */
const risingFeed = from(postHourlyStats)
  .dimensions({
    postId: p.postId,
    communityId: p.communityId,
    hour: bucket("hour", p.bucket),
  })
  .metrics({
    votes: sum(p.votes),
    comments: sum(p.comments),
    engagement: max(p.engagementScore),
  })
  .windows({
    voteMa6h: movingAvg("votes", {
      partitionBy: ["postId"],
      orderBy: ["hour"],
      rows: 6,
    }),
    communityRank: rank({
      partitionBy: ["communityId", "hour"],
      orderBy: [descending("engagement")],
    }),
  })
  .compareToPreviousWindow("votes")
  .orderBy(descending("voteMa6h"))
  .limit(50);

/** A presentation-ready daily time series with the previous-day view delta. */
const dailyTrend = from(postHourlyStats)
  .dimensions({ day: bucket("day", p.bucket) })
  .metrics({ views: sum(p.views), votes: sum(p.votes) })
  .compareToPreviousWindow("views")
  .orderBy("day");

const QUERIES = [
  { label: "engagement over time (hourly)", query: engagementOverTime },
  { label: "rising feed (velocity + community rank)", query: risingFeed },
  { label: "daily trend (previous-day delta)", query: dailyTrend },
] as const;

// ── Dry-run: render + capability-check every query ──────────────────────────

function section(title: string): void {
  console.log(`\n══ ${title} ${"═".repeat(Math.max(0, 58 - title.length))}`);
}

for (const { label, query } of QUERIES) {
  section(label);
  // Preflight: unsupported analytics fail typed here, never at the engine.
  const support = supportsQuery(query, { dialect: "postgres" });
  console.log(`supported on postgres: ${support.supported}`);
  const { text, params } = query.render({ dialect: "postgres" });
  console.log(`${text};`);
  console.log(`   -- params: ${JSON.stringify(params)}`);
}

// ── Live: seed a demo rollup and execute ────────────────────────────────────

const url = readEnv("DATABASE_URL");
if (url === undefined) {
  console.log(
    "\n(Set DATABASE_URL to also execute these against a scratch Postgres. " +
      "In a real pipeline, postgres-family-etl-cron populates this table.)",
  );
} else {
  const db = await connect({ url });
  try {
    await ensureRollup(db);
    section("Live execution (DATABASE_URL)");
    const rows = await risingFeed.execute(db);
    console.log(`rising feed rows: ${rows.length}`);
    for (const row of rows.slice(0, 5)) {
      console.log(
        `  community ${row.communityId} post ${row.postId} @ ${
          String(row.hour)
        } — voteMa6h=${row.voteMa6h?.toFixed(2)} rank=${row.communityRank} ` +
          `Δvotes=${row.votesDelta ?? "—"}`,
      );
    }
    const trend = await dailyTrend.execute(db);
    console.log(`\ndaily trend rows: ${trend.length}`);
    console.log("\n✓ PostgreSQL-family analytics example complete.");
  } finally {
    await db.close();
  }
}

/** Creates the rollup table (additive DDL) and seeds a small deterministic
 * rollup idempotently, so `execute` returns rows on a fresh database. */
async function ensureRollup(db: PgDatabase): Promise<void> {
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [postHourlyStats],
  });
  for (const statement of generatePostgresUpStatements(snapshot).statements) {
    await db.execute(statement);
  }
  const base = new Date("2026-01-01T00:00:00.000Z").getTime();
  const rows = [];
  for (let post = 1; post <= 3; post += 1) {
    const communityId = post === 3 ? "gaming" : "news";
    for (let hour = 0; hour < 8; hour += 1) {
      const votes = (post * 2 + hour) % 7;
      const comments = (post + hour) % 4;
      const views = votes * 5 + comments * 2 + hour;
      rows.push({
        postId: String(post),
        communityId,
        bucket: new Date(base + hour * 3_600_000),
        views,
        votes,
        comments,
        engagementScore: votes * 2 + comments * 3 + views * 0.25,
      });
    }
  }
  await db.insert(postHourlyStats).values(rows)
    .onConflictDoNothing({
      target: [p.postId, p.communityId, p.bucket],
    })
    .execute();
}

/** Reads an environment variable, tolerating a missing `--allow-env`. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}
