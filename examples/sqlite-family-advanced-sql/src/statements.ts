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
  identifier,
  isNotNull,
  jsonTable,
  lag,
  lt,
  lte,
  min,
  over,
  rank,
  raw,
  renderSql,
  rowNumber,
  type Sql,
  sql,
  sum,
} from "@sisal/orm";

import { comments, documents, events, hourlyStats } from "./schema.ts";

export type AdvancedImplementation =
  | "builder"
  | "raw"
  | "hybrid"
  | "raw-ddl"
  | "skipped"
  | "not-applicable";

export type SqliteCapability =
  | "window"
  | "recursive"
  | "json"
  | "generated"
  | "returning";

export interface AdvancedSqlCase {
  readonly id: string;
  readonly title: string;
  readonly contract: string;
  readonly implementation: AdvancedImplementation;
  readonly statements: readonly Sql[];
  readonly requires?: SqliteCapability;
  readonly v08PainPoint: string;
  readonly live: boolean;
}

export interface RenderedAdvancedSqlCase {
  readonly id: string;
  readonly title: string;
  readonly implementation: AdvancedImplementation;
  readonly sql: readonly string[];
  readonly params: readonly (readonly unknown[])[];
}

const gen = createDatabase({ dialect: "sqlite" });

export const FROM = "2026-01-01 00:00:00";
export const UNTIL = "2026-01-02 00:00:00";

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
      v08PainPoint: "Expression aliases would avoid repeating FILTER metrics.",
      live: true,
    },
    {
      id: "02",
      title: "Window analytics",
      contract: "02-window-analytics",
      implementation: "builder",
      statements: [windowAnalytics(db)],
      requires: "window",
      v08PainPoint:
        "Builder-native via over()/avg()/rank() with a ROWS frame; the " +
        "engagement rank expression is reused in SELECT and ORDER BY.",
      live: true,
    },
    {
      id: "03",
      title: "Sessionization",
      contract: "03-sessionization",
      implementation: "hybrid",
      statements: [sessionization(db)],
      requires: "window",
      v08PainPoint:
        "Builder CTEs with lag()/sum() windows; the 30-minute gap uses " +
        "dateDiff() (julianday under SQLite) and the CASE flag stays inline.",
      live: true,
    },
    {
      id: "04",
      title: "Top-N per group",
      contract: "04-top-n-per-group",
      implementation: "builder",
      statements: [topNPerGroup(db)],
      requires: "window",
      v08PainPoint:
        "Builder-native via a rowNumber() window in a derived table that the " +
        "outer query filters by rank.",
      live: true,
    },
    {
      id: "05",
      title: "Cohort retention",
      contract: "05-cohort-retention",
      implementation: "hybrid",
      statements: [cohortRetention(db)],
      v08PainPoint:
        "Builder CTEs joined with countDistinct(); SQLite day bucketing " +
        "(date()) stays an inline fragment.",
      live: true,
    },
    {
      id: "06",
      title: "Funnel analysis",
      contract: "06-funnel-analysis",
      implementation: "hybrid",
      statements: [funnelAnalysis(db)],
      v08PainPoint:
        "Builder CTE with filter(min())/count() filters; the +1 day window " +
        "(datetime()) stays an inline fragment.",
      live: true,
    },
    {
      id: "07",
      title: "Recursive comments",
      contract: "07-recursive-comments",
      implementation: "hybrid",
      statements: [recursiveComments(db)],
      requires: "recursive",
      v08PainPoint:
        "Builder-native via $withRecursive with a depth guard; the printf/" +
        "path materialization stays inline.",
      live: true,
    },
    {
      id: "08",
      title: "Job queue CAS claim",
      contract: "08-job-queue-locking",
      implementation: "raw",
      statements: [claimJobCas()],
      requires: "returning",
      v08PainPoint:
        "SQLite needs a documented CAS queue strategy instead of row locks.",
      live: true,
    },
    {
      id: "09",
      title: "Idempotent backfill",
      contract: "09-idempotent-backfill",
      implementation: "skipped",
      statements: [],
      v08PainPoint:
        "Skipped until checkpoint/watermark contracts are designed.",
      live: false,
    },
    {
      id: "10",
      title: "JSON table extraction",
      contract: "10-json-table-extraction",
      implementation: "builder",
      statements: [jsonTableExtraction(db)],
      requires: "json",
      v08PainPoint:
        "Builder-native via jsonTable() compiling to SQLite json_each + " +
        "per-field json_extract.",
      live: true,
    },
    {
      id: "11",
      title: "Generated columns and indexes",
      contract: "11-generated-columns-indexes",
      implementation: "raw-ddl",
      statements: generatedColumnDdl(),
      requires: "generated",
      v08PainPoint:
        "Generated columns and partial indexes now ship in schema snapshots; " +
        "this case keeps literal DDL to show the STORED column and the " +
        "partial index shape verbatim.",
      live: true,
    },
    {
      id: "12",
      title: "MySQL compatibility",
      contract: "12-mysql-compatibility",
      implementation: "not-applicable",
      statements: [],
      v08PainPoint: "Not applicable to the SQLite family.",
      live: false,
    },
  ];
}

export function renderAdvancedSqlCases(
  identity: DialectIdentity = { dialect: "sqlite" },
): readonly RenderedAdvancedSqlCase[] {
  return advancedSqlCases().map((entry) => {
    const rendered = entry.statements.map((statement) =>
      renderSql(statement, identity)
    );
    return {
      id: entry.id,
      title: entry.title,
      implementation: entry.implementation,
      sql: rendered.map((item) => item.text),
      params: rendered.map((item) => item.params),
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

// Contract 02: builder-native window analytics. The engagement-rank window is
// bound once and reused in the projection and the ORDER BY (expr alias reuse).
function windowAnalytics(db: Database): Sql {
  const h = hourlyStats.columns;
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
    .orderBy(asc(h.bucket), engagementRank)
    .toSql();
}

// Contract 03: hybrid sessionization. Builder CTEs carry the lag()/sum()
// windows; the 30-minute gap uses the portable dateDiff() (julianday under
// SQLite) and the boolean session-start flag stays an inline CASE.
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

// Contract 04: builder-native top-N per group. A rowNumber() window numbers the
// derived table, and the outer query filters by rank.
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

// Contract 05: hybrid cohort retention. Builder CTEs are joined and counted
// with countDistinct(); SQLite day bucketing (date()) stays an inline fragment.
function cohortRetention(db: Database): Sql {
  const e = events.columns;
  const firstSeen = db.$with("first_seen").as(
    db.select({
      actor_id: e.actor_id,
      cohort_day: sql`date(${min(e.occurred_at)})`,
    }).from(events).groupBy(e.actor_id),
  );
  const activity = db.$with("activity").as(
    db.select({
      actor_id: e.actor_id,
      activity_day: sql`date(${e.occurred_at})`,
    }).from(events).where(gte(e.occurred_at, FROM)),
  );
  return db.with(firstSeen, activity).select({
    cohort_day: firstSeen.cohort_day,
    activity_day: activity.activity_day,
    retained_actors: countDistinct(activity.actor_id),
  }).from(
    sql`${identifier("first_seen")} inner join ${
      identifier("activity")
    } on ${activity.actor_id} = ${firstSeen.actor_id}`,
  )
    .groupBy(firstSeen.cohort_day, activity.activity_day)
    .orderBy(asc(firstSeen.cohort_day), asc(activity.activity_day))
    .toSql();
}

// Contract 06: hybrid funnel analysis. The first-event CTE uses filter(min())
// per kind; the outer counts use count() filters whose +1 day window
// (datetime()) stays an inline fragment.
function funnelAnalysis(db: Database): Sql {
  const e = events.columns;
  const firstEvents = db.$with("first_events").as(
    db.select({
      actor_id: e.actor_id,
      viewed_at: filter(min(e.occurred_at), eq(e.kind, "view")),
      voted_at: filter(min(e.occurred_at), eq(e.kind, "vote")),
      commented_at: filter(min(e.occurred_at), eq(e.kind, "comment")),
    }).from(events).where(gte(e.occurred_at, FROM)).groupBy(e.actor_id),
  );
  const withinDay = (column: unknown) =>
    and(
      isNotNull(column),
      lte(column, sql`datetime(${firstEvents.viewed_at}, ${"+1 day"})`),
    );
  return db.with(firstEvents).select({
    viewed: filter(count(), isNotNull(firstEvents.viewed_at)),
    voted_within_day: filter(count(), withinDay(firstEvents.voted_at)),
    commented_within_day: filter(count(), withinDay(firstEvents.commented_at)),
  }).from(firstEvents).toSql();
}

// Contract 07: hybrid recursive comments. $withRecursive supplies the WITH
// RECURSIVE shape and the depth guard; the printf/path materialization stays
// inline (SQLite has no builder equivalent).
function recursiveComments(db: Database): Sql {
  const c = comments.columns;
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
      path: sql`printf('%08d', ${c.id})`,
    }).from(comments).where(eq(c.id, 1))
      .unionAll(
        db.select({
          id: c.id,
          parent_id: c.parent_id,
          body: c.body,
          depth: sql`${self.depth} + 1`,
          path: sql`${self.path} || '.' || printf('%08d', ${c.id})`,
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

function claimJobCas(): Sql {
  return sql`
    update sisal_adv_jobs
    set
      status = ${"claimed"},
      locked_by = ${"worker-1"},
      locked_at = datetime('now')
    where id = (
      select id
      from sisal_adv_jobs
      where status = ${"pending"}
      order by priority desc, id asc
      limit 1
    )
      and status = ${"pending"}
    returning id, priority
  `;
}

// Contract 10: builder-native JSON-table extraction. jsonTable() compiles to
// SQLite json_each + per-field json_extract; the base table joins the
// set-returning function through the documented lateral (comma) FROM.
function jsonTableExtraction(db: Database): Sql {
  const d = documents.columns;
  const items = jsonTable(d.payload, {
    sku: { type: "text", path: "$.sku" },
    qty: { type: "integer", path: "$.qty" },
  }, { as: "item", path: "$.items" });
  return db.select({
    document_id: d.id,
    sku: items.columns.sku,
    qty: items.columns.qty,
  }).from(sql`${identifier(documents.name)}, ${items.from}`)
    .where(eq(d.id, 1))
    .toSql();
}

function generatedColumnDdl(): readonly Sql[] {
  return [
    sql`
      create table if not exists sisal_adv_generated_documents (
        id integer primary key,
        payload text not null,
        title_text text generated always as
          (json_extract(payload, '$.title')) stored
      )
    `,
    sql`
      create index if not exists sisal_adv_generated_documents_title_idx
        on sisal_adv_generated_documents (title_text)
        where title_text is not null
    `,
  ];
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
    values (${1}, ${
    JSON.stringify({
      title: "Advanced SQL",
      items: [{ sku: "book", qty: 2 }],
    })
  })
  `,
];

export const cleanupStatements: readonly Sql[] = [
  raw("drop table if exists sisal_adv_generated_documents"),
  raw("drop table if exists sisal_adv_backfill_state"),
  raw("drop table if exists sisal_adv_documents"),
  raw("drop table if exists sisal_adv_jobs"),
  raw("drop table if exists sisal_adv_comments"),
  raw("drop table if exists sisal_adv_hourly_stats"),
  raw("drop table if exists sisal_adv_events"),
  raw("drop table if exists sisal_adv_posts"),
];
