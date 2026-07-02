import {
  and,
  asc,
  avg,
  count,
  countDistinct,
  createDatabase,
  type Database,
  dateDiff,
  dateTrunc,
  desc,
  type DialectIdentity,
  eq,
  excluded,
  filter,
  gte,
  jsonTable,
  lag,
  lt,
  lte,
  min,
  OrmError,
  over,
  rank,
  raw,
  renderSql,
  rowNumber,
  type Sql,
  sql,
  sum,
} from "@sisal/orm";

import { comments, events, hourlyStats, jobs, posts } from "./schema.ts";

export type AdvancedImplementation =
  | "builder"
  | "raw"
  | "hybrid"
  | "raw-ddl"
  | "guarded";

export interface AdvancedSqlCase {
  readonly id: string;
  readonly title: string;
  readonly contract: string;
  readonly implementation: AdvancedImplementation;
  readonly statements: readonly Sql[];
  readonly v08PainPoint: string;
  readonly live: boolean;
}

export interface RenderedAdvancedSqlCase {
  readonly id: string;
  readonly title: string;
  readonly implementation: AdvancedImplementation;
  readonly sql: readonly string[];
  readonly params: readonly (readonly unknown[])[];
  readonly errors: readonly string[];
}

const gen = createDatabase({ dialect: "mysql" });

export const FROM = "2026-01-01 00:00:00.000000";
export const UNTIL = "2026-01-02 00:00:00.000000";

export function advancedSqlCases(
  db: Database = gen,
): readonly AdvancedSqlCase[] {
  const rollup = etlRollup(db);
  return [
    {
      id: "01",
      title: "ETL rollup",
      contract: "01-etl-rollup",
      implementation: "builder",
      statements: [rollup],
      v08PainPoint:
        "Expression aliases would avoid repeating CASE-rebuilt FILTER metrics.",
      live: true,
    },
    {
      id: "02",
      title: "Window analytics",
      contract: "02-window-analytics",
      implementation: "builder",
      statements: [windowAnalytics(db)],
      v08PainPoint:
        "over()/rank()/avg() with a rows frame now render this natively; " +
        "MySQL has no ORDER BY alias reuse, so the rank window repeats there.",
      live: true,
    },
    {
      id: "03",
      title: "Sessionization",
      contract: "03-sessionization",
      implementation: "hybrid",
      statements: [sessionization(db)],
      v08PainPoint:
        "lag(), dateDiff(), and reusable window specs now render this; the " +
        "session-boundary CASE stays an inline fragment.",
      live: true,
    },
    {
      id: "04",
      title: "Top-N per group",
      contract: "04-top-n-per-group",
      implementation: "builder",
      statements: [topNPerGroup(db)],
      v08PainPoint:
        "rowNumber() plus a derived-table .as() now express Top-N natively.",
      live: true,
    },
    {
      id: "05",
      title: "Cohort retention",
      contract: "05-cohort-retention",
      implementation: "hybrid",
      statements: [cohortRetention(db)],
      v08PainPoint:
        "The first-seen CTE, join, and countDistinct are builder-native; " +
        "day bucketing stays an inline date() fragment.",
      live: true,
    },
    {
      id: "06",
      title: "Funnel analysis",
      contract: "06-funnel-analysis",
      implementation: "hybrid",
      statements: [funnelAnalysis(db)],
      v08PainPoint:
        "filter(min(...)) rebuilds the first-event pivots as CASE; the " +
        "day-window funnel math stays inline (timestampadd).",
      live: true,
    },
    {
      id: "07",
      title: "Recursive comments",
      contract: "07-recursive-comments",
      implementation: "hybrid",
      statements: [recursiveComments(db)],
      v08PainPoint:
        "$withRecursive() renders WITH RECURSIVE with the self-reference " +
        "guard; depth/path expressions stay inline fragments.",
      live: true,
    },
    {
      id: "08",
      title: "Job queue locking",
      contract: "08-job-queue-locking",
      implementation: "builder",
      statements: [claimJob(db)],
      v08PainPoint: "Needs a portable advisory lock and claim abstraction.",
      live: true,
    },
    {
      id: "09",
      title: "Idempotent backfill",
      contract: "09-idempotent-backfill",
      implementation: "hybrid",
      statements: [rollup, checkpoint()],
      v08PainPoint: "Needs checkpoint/watermark contracts and failure tests.",
      live: true,
    },
    {
      id: "10",
      title: "JSON table extraction",
      contract: "10-json-table-extraction",
      implementation: "hybrid",
      statements: [jsonTableExtraction(db)],
      v08PainPoint:
        "jsonTable() renders JSON_TABLE with a typed COLUMNS clause; the " +
        "documents table is referenced inline (no defineTable in this demo).",
      live: true,
    },
    {
      id: "11",
      title: "Generated columns and indexes",
      contract: "11-generated-columns-indexes",
      implementation: "raw-ddl",
      statements: generatedColumnDdl(),
      v08PainPoint:
        "Generated columns (.generatedAs()) and the fail-closed partial-index " +
        "capability error both ship; this plain stored-column index stays a " +
        "hand-written CREATE TABLE built outside the snapshot flow.",
      live: true,
    },
    {
      id: "12",
      title: "MySQL compatibility pressure cases",
      contract: "12-mysql-compatibility",
      implementation: "guarded",
      statements: [upsertPressure(db), returningGuard(db)],
      v08PainPoint:
        "RETURNING is version/variant-gated; write-result semantics need a capability descriptor.",
      live: false,
    },
  ];
}

export function renderAdvancedSqlCases(
  identity: DialectIdentity = { dialect: "mysql" },
): readonly RenderedAdvancedSqlCase[] {
  return advancedSqlCases().map((entry) => {
    const sqlText: string[] = [];
    const params: Array<readonly unknown[]> = [];
    const errors: string[] = [];
    for (const statement of entry.statements) {
      try {
        const rendered = renderSql(statement, identity);
        sqlText.push(rendered.text);
        params.push(rendered.params);
      } catch (error) {
        if (error instanceof OrmError) {
          errors.push(`${error.code}: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
    return {
      id: entry.id,
      title: entry.title,
      implementation: entry.implementation,
      sql: sqlText,
      params,
      errors,
    };
  });
}

function etlRollup(db: Database): Sql {
  const e = events.columns;
  const h = hourlyStats.columns;
  const bucket = dateTrunc("hour", e.occurred_at);
  return db.insert(hourlyStats).select(
    db.select({
      post_id: e.post_id,
      bucket,
      views: filter(count(), eq(e.kind, "view")),
      votes: filter(count(), eq(e.kind, "vote")),
      comments: filter(count(), eq(e.kind, "comment")),
      engagement_score: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
        filter(count(), eq(e.kind, "comment"))
      } * 3.0`,
    }).from(events)
      .where(and(gte(e.occurred_at, FROM), lt(e.occurred_at, UNTIL)))
      .groupBy(e.post_id, bucket),
  ).onConflictDoUpdate({
    target: [h.post_id, h.bucket],
    set: {
      views: excluded(h.views),
      votes: excluded(h.votes),
      comments: excluded(h.comments),
      engagement_score: excluded(h.engagement_score),
    },
  }).toSql();
}

function windowAnalytics(db: Database): Sql {
  const h = hourlyStats.columns;
  // MySQL forbids referencing a SELECT alias in ORDER BY, so the ranking window
  // is defined once and reused in both the projection and the ORDER BY.
  const engagementRank = over(rank(), {
    partitionBy: [h.bucket],
    orderBy: [desc(h.engagement_score)],
  });
  return db.select({
    post_id: h.post_id,
    bucket: h.bucket,
    votes: h.votes,
    vote_ma_6h: over(avg(h.votes), {
      partitionBy: [h.post_id],
      orderBy: [asc(h.bucket)],
      frame: { unit: "rows", start: { preceding: 5 }, end: "currentRow" },
    }),
    engagement_rank: engagementRank,
  }).from(hourlyStats)
    .where(gte(h.bucket, FROM))
    .orderBy(asc(h.bucket), asc(engagementRank))
    .toSql();
}

function sessionization(db: Database): Sql {
  const e = events.columns;
  const ordered = db.$with("ordered").as(
    db.select({
      actor_id: e.actor_id,
      occurred_at: e.occurred_at,
      previous_at: over(lag(e.occurred_at), {
        partitionBy: [e.actor_id],
        orderBy: [asc(e.occurred_at)],
      }),
    }).from(events).where(gte(e.occurred_at, FROM)),
  );
  // The gap test uses portable dateDiff() (→ TIMESTAMPDIFF on MySQL); the
  // boundary flag stays an inline CASE fragment over the CTE's columns.
  const flagged = db.$with("flagged").as(
    db.select({
      actor_id: ordered.actor_id,
      occurred_at: ordered.occurred_at,
      starts_new_session: sql`case when ${ordered.previous_at} is null or ${
        dateDiff("minutes", ordered.previous_at, ordered.occurred_at)
      } > ${30} then 1 else 0 end`,
    }).from(ordered),
  );
  return db.with(ordered, flagged).select({
    actor_id: flagged.actor_id,
    occurred_at: flagged.occurred_at,
    session_number: over(sum(flagged.starts_new_session), {
      partitionBy: [flagged.actor_id],
      orderBy: [asc(flagged.occurred_at)],
    }),
  }).from(flagged).toSql();
}

function topNPerGroup(db: Database): Sql {
  const h = hourlyStats.columns;
  const ranked = db.select({
    post_id: h.post_id,
    bucket: h.bucket,
    engagement_score: h.engagement_score,
    rn: over(rowNumber(), {
      partitionBy: [h.post_id],
      orderBy: [desc(h.engagement_score), desc(h.bucket)],
    }),
  }).from(hourlyStats).where(gte(h.bucket, FROM)).as("ranked");
  return db.select({
    post_id: ranked.post_id,
    bucket: ranked.bucket,
    engagement_score: ranked.engagement_score,
    rn: ranked.rn,
  }).from(ranked).where(lte(ranked.rn, 3)).toSql();
}

function cohortRetention(db: Database): Sql {
  const e = events.columns;
  // `first_seen` is one row per actor, so the original `activity` CTE folds
  // into the join against the events table (same result, one fewer CTE). Day
  // bucketing uses an inline date() fragment (MySQL DATE(), not date_trunc).
  const firstSeen = db.$with("first_seen").as(
    db.select({
      actor_id: e.actor_id,
      cohort_day: sql`date(${min(e.occurred_at)})`,
    }).from(events).groupBy(e.actor_id),
  );
  const activityDay = sql`date(${e.occurred_at})`;
  return db.with(firstSeen).select({
    cohort_day: firstSeen.cohort_day,
    activity_day: activityDay,
    retained_actors: countDistinct(e.actor_id),
  }).from(firstSeen)
    .innerJoin(events, eq(e.actor_id, firstSeen.actor_id))
    .where(gte(e.occurred_at, FROM))
    .groupBy(firstSeen.cohort_day, activityDay)
    .orderBy(asc(firstSeen.cohort_day), asc(activityDay))
    .toSql();
}

function funnelAnalysis(db: Database): Sql {
  const e = events.columns;
  // filter() has no native MySQL FILTER, so each first-event pivot rebuilds as
  // min(CASE WHEN kind = ? THEN occurred_at END) — exactly the original SQL.
  const firstEvents = db.$with("first_events").as(
    db.select({
      actor_id: e.actor_id,
      viewed_at: filter(min(e.occurred_at), eq(e.kind, "view")),
      voted_at: filter(min(e.occurred_at), eq(e.kind, "vote")),
      commented_at: filter(min(e.occurred_at), eq(e.kind, "comment")),
    }).from(events).where(gte(e.occurred_at, FROM)).groupBy(e.actor_id),
  );
  // The within-a-day funnel math is engine-specific (timestampadd), so the
  // outer metrics stay inline CASE fragments over the CTE's columns.
  return db.with(firstEvents).select({
    viewed:
      sql`sum(case when ${firstEvents.viewed_at} is not null then 1 else 0 end)`,
    voted_within_day:
      sql`sum(case when ${firstEvents.voted_at} is not null and ${firstEvents.voted_at} <= timestampadd(day, ${1}, ${firstEvents.viewed_at}) then 1 else 0 end)`,
    commented_within_day:
      sql`sum(case when ${firstEvents.commented_at} is not null and ${firstEvents.commented_at} <= timestampadd(day, ${1}, ${firstEvents.viewed_at}) then 1 else 0 end)`,
  }).from(firstEvents).toSql();
}

function recursiveComments(db: Database): Sql {
  const c = comments.columns;
  // The recursive step MUST read the CTE via .from(self) and walk the base
  // table with an inner join; a build-time guard rejects the self-join bug.
  const thread = db.$withRecursive("thread", [
    "id",
    "parent_id",
    "body",
    "depth",
    "path",
  ]).as((self) =>
    db.select({
      id: c.id,
      parent_id: c.parent_id,
      body: c.body,
      depth: sql`0`,
      path: sql`cast(lpad(cast(${c.id} as char), 8, '0') as char(512))`,
    }).from(comments).where(eq(c.id, 1))
      .unionAll(
        db.select({
          id: c.id,
          parent_id: c.parent_id,
          body: c.body,
          depth: sql`${self.depth} + 1`,
          path:
            sql`concat(${self.path}, '.', lpad(cast(${c.id} as char), 8, '0'))`,
        }).from(self)
          .innerJoin(comments, eq(c.parent_id, self.id))
          .where(lt(self.depth, 8)),
      )
  );
  return db.with(thread).select({
    id: thread.id,
    parent_id: thread.parent_id,
    body: thread.body,
    depth: thread.depth,
  }).from(thread).orderBy(asc(thread.path)).toSql();
}

function claimJob(db: Database): Sql {
  return db.select({
    id: jobs.columns.id,
    priority: jobs.columns.priority,
  }).from(jobs)
    .where(eq(jobs.columns.status, "pending"))
    .orderBy(desc(jobs.columns.priority), asc(jobs.columns.id))
    .limit(1)
    .for("update", { skipLocked: true })
    .toSql();
}

function checkpoint(): Sql {
  return sql`
    insert into sisal_adv_backfill_state
      (name, high_watermark, updated_at)
    values (${"hourly-rollup"}, ${UNTIL}, now(6))
    on duplicate key update
      high_watermark = values(high_watermark),
      updated_at = values(updated_at)
  `;
}

function jsonTableExtraction(db: Database): Sql {
  // jsonTable() renders the JSON_TABLE COLUMNS clause on MySQL. The documents
  // table has no defineTable in this demo, so it is referenced inline and
  // cross-joined with the set-returning function.
  const item = jsonTable(sql`d.payload`, {
    sku: { type: "text", path: "$.sku" },
    qty: { type: "integer", path: "$.qty" },
  }, { as: "item", path: "$.items" });
  return db.select({
    document_id: sql`d.id`,
    sku: item.columns.sku,
    qty: item.columns.qty,
  }).from(sql`sisal_adv_documents d join ${item.from}`)
    .where(eq(sql`d.id`, 1))
    .toSql();
}

function generatedColumnDdl(): readonly Sql[] {
  return [
    sql`
      create table if not exists sisal_adv_documents (
        id int primary key,
        payload json not null,
        title_text varchar(255) generated always as
          (json_unquote(json_extract(payload, '$.title'))) stored,
        index sisal_adv_documents_title_idx (title_text)
      )
    `,
  ];
}

function upsertPressure(db: Database): Sql {
  return db.insert(posts).values({
    id: 1,
    community_id: 10,
    title: "Intro",
    status: "published",
    created_at: FROM,
    hot_score: 0,
  }).onConflictDoUpdate({
    target: posts.columns.id,
    set: { hot_score: sql`${posts.columns.hot_score} + ${1}` },
  }).toSql();
}

function returningGuard(db: Database): Sql {
  return db.insert(posts).values({
    id: 99,
    community_id: 10,
    title: "Returning guard",
    status: "draft",
    created_at: FROM,
    hot_score: 0,
  }).returning().toSql();
}

export const seedStatements: readonly Sql[] = [
  sql`
    insert into sisal_adv_posts
      (id, community_id, title, status, created_at, hot_score)
    values
      (${1}, ${10}, ${"Intro"}, ${"published"}, ${FROM}, ${0}),
      (${2}, ${10}, ${"Deep dive"}, ${"published"}, ${FROM}, ${0})
  `,
  sql`
    insert into sisal_adv_events
      (id, post_id, actor_id, kind, value, occurred_at)
    values
      (${1}, ${1}, ${101}, ${"view"}, ${1}, ${FROM}),
      (${2}, ${1}, ${101}, ${"vote"}, ${1}, ${FROM}),
      (${3}, ${1}, ${102}, ${"comment"}, ${1}, ${FROM}),
      (${4}, ${2}, ${103}, ${"view"}, ${1}, ${FROM})
  `,
  sql`
    insert into sisal_adv_comments (id, parent_id, body)
    values (${1}, ${null}, ${"root"}), (${2}, ${1}, ${"reply"})
  `,
  sql`
    insert into sisal_adv_jobs (id, status, priority, locked_by, locked_at)
    values (${1}, ${"pending"}, ${10}, ${null}, ${null})
  `,
  sql`
    insert into sisal_adv_documents (id, payload)
    values (${1}, ${{
    title: "Advanced SQL",
    items: [{ sku: "book", qty: 2 }],
  }})
  `,
];

export const documentDdl = generatedColumnDdl;

export const cleanupStatements: readonly Sql[] = [
  raw("drop table if exists sisal_adv_documents"),
  raw("drop table if exists sisal_adv_backfill_state"),
  raw("drop table if exists sisal_adv_jobs"),
  raw("drop table if exists sisal_adv_comments"),
  raw("drop table if exists sisal_adv_hourly_stats"),
  raw("drop table if exists sisal_adv_events"),
  raw("drop table if exists sisal_adv_posts"),
];
