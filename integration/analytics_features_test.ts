/**
 * Live PostgreSQL proof for `@sisal/analytics`: descriptors render and
 * execute against a real adapter, including text-normalized `bucket()` values,
 * metrics, windowed metrics, previous-window comparison, ordering, limits, and
 * bound parameters.
 *
 * Gated on `DATABASE_URL` (skipped when unset), like `pg_features_test.ts`.
 * Run:
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
 *     deno test --allow-net --allow-env --allow-read \
 *     integration/analytics_features_test.ts
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import { columns, createSchemaSnapshot, defineTable, gte } from "@sisal/orm";
import {
  bucket,
  descending,
  from,
  movingAvg,
  rank,
  sum,
} from "@sisal/analytics";
import { connect } from "@sisal/pg";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";
import { env } from "./_shared/env.ts";

const URL = env("DATABASE_URL");
const SKIP = URL === undefined;

const TABLE = "it_analytics_hourly_stats";

const postHourlyStats = defineTable(TABLE, {
  postId: columns.text().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  votes: columns.doublePrecision().notNull(),
  comments: columns.doublePrecision().notNull(),
});

const s = postHourlyStats.columns;
const FROM = new Date("2026-01-01T00:00:00.000Z");

function at(hours: number): Date {
  return new Date(FROM.getTime() + hours * 3_600_000);
}

interface AnalyticsRow {
  readonly postId: string;
  readonly bucket: string;
  readonly votes: number;
  readonly comments: number;
  readonly voteMa2h: number;
  readonly hourlyRank: string | number;
  readonly votesPrevious: number | null;
  readonly votesDelta: number | null;
}

Deno.test({
  name: "analytics: live Postgres query returns typed bucket and windows",
  ignore: SKIP,
  async fn() {
    const db = await connect({ url: URL! });
    try {
      await db.execute("set client_min_messages to warning");
      await reset(db);

      const query = from(postHourlyStats)
        .where(gte(s.bucket, FROM))
        .dimensions({
          postId: s.postId,
          bucket: bucket("hour", s.bucket),
        })
        .metrics({
          votes: sum(s.votes),
          comments: sum(s.comments),
        })
        .windows({
          voteMa2h: movingAvg("votes", {
            partitionBy: ["postId"],
            orderBy: ["bucket"],
            rows: 2,
          }),
          hourlyRank: rank({
            partitionBy: ["bucket"],
            orderBy: [descending("votes")],
          }),
        })
        .compareToPreviousWindow("votes")
        .orderBy("bucket", "postId")
        .limit(10);

      const rendered = query.render({ dialect: "postgres" });
      assert(!rendered.text.includes(FROM.toISOString()));
      assertEquals(rendered.params, [FROM, 10]);

      const rows = await query.execute(db) as readonly AnalyticsRow[];
      assertEquals(
        rows.map((row) => ({
          ...row,
          hourlyRank: Number(row.hourlyRank),
        })),
        [
          {
            postId: "p1",
            bucket: "2026-01-01 00:00:00",
            votes: 1,
            comments: 0,
            voteMa2h: 1,
            hourlyRank: 2,
            votesPrevious: null,
            votesDelta: null,
          },
          {
            postId: "p2",
            bucket: "2026-01-01 00:00:00",
            votes: 2,
            comments: 2,
            voteMa2h: 2,
            hourlyRank: 1,
            votesPrevious: null,
            votesDelta: null,
          },
          {
            postId: "p1",
            bucket: "2026-01-01 01:00:00",
            votes: 3,
            comments: 1,
            voteMa2h: 2,
            hourlyRank: 1,
            votesPrevious: 1,
            votesDelta: 2,
          },
          {
            postId: "p2",
            bucket: "2026-01-01 01:00:00",
            votes: 1,
            comments: 0,
            voteMa2h: 1.5,
            hourlyRank: 2,
            votesPrevious: 2,
            votesDelta: -1,
          },
          {
            postId: "p1",
            bucket: "2026-01-01 02:00:00",
            votes: 5,
            comments: 0,
            voteMa2h: 4,
            hourlyRank: 1,
            votesPrevious: 3,
            votesDelta: 2,
          },
        ],
      );
      assert(rows.every((row) => typeof row.bucket === "string"));
    } finally {
      await cleanup(db);
      await db.close();
    }
  },
});

async function reset(db: Awaited<ReturnType<typeof connect>>): Promise<void> {
  await cleanup(db);
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [postHourlyStats],
  });
  const { statements, destructive } = generatePostgresUpStatements(snapshot);
  assertEquals(destructive, []);
  for (const statement of statements) {
    await db.execute(statement);
  }
  await db.insert(postHourlyStats).values([
    { postId: "p1", bucket: at(0), votes: 1, comments: 0 },
    { postId: "p2", bucket: at(0), votes: 2, comments: 2 },
    { postId: "p1", bucket: at(1), votes: 3, comments: 1 },
    { postId: "p2", bucket: at(1), votes: 1, comments: 0 },
    { postId: "p1", bucket: at(2), votes: 5, comments: 0 },
  ]).execute();
}

async function cleanup(db: Awaited<ReturnType<typeof connect>>): Promise<void> {
  await db.execute(`drop table if exists ${TABLE} cascade`);
}
