import {
  and,
  asc,
  avg,
  count,
  countDistinct,
  createDatabase,
  createSchemaSnapshot,
  type Database,
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
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

import { comments, documents, events, hourlyStats, jobs } from "./schema.ts";

export type AdvancedImplementation =
  | "builder"
  | "raw"
  | "hybrid"
  | "raw-ddl"
  | "linked";

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
}

const gen = createDatabase({ dialect: "postgres" });

export const FROM = new Date("2026-01-01T00:00:00Z");
export const UNTIL = new Date("2026-01-02T00:00:00Z");

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
      v08PainPoint:
        "Now builder-native: over() with a ROWS frame drives the moving " +
        "average and rank() the ranking window; the ranking expression is " +
        "reused in ORDER BY instead of an output-alias reference.",
      live: true,
    },
    {
      id: "03",
      title: "Sessionization",
      contract: "03-sessionization",
      implementation: "hybrid",
      statements: [sessionization(db)],
      v08PainPoint:
        "Now builder-native: $with() CTEs, lag() over() for the previous " +
        "event, and sum() over() for the running session count. The gap test " +
        "stays an inline `x - y > '30 minutes'::interval` fragment — dateDiff() " +
        "truncates to whole units and would shift the 30-31 minute boundary.",
      live: true,
    },
    {
      id: "04",
      title: "Top-N per group",
      contract: "04-top-n-per-group",
      implementation: "builder",
      statements: [topNPerGroup(db)],
      v08PainPoint:
        "Now builder-native: row_number() over() inside a subquery aliased " +
        "with .as(), then an outer filter on the ranked derived table.",
      live: true,
    },
    {
      id: "05",
      title: "Cohort retention",
      contract: "05-cohort-retention",
      implementation: "hybrid",
      statements: [cohortRetention(db)],
      v08PainPoint:
        "Now builder-native: $with() CTEs, dateTrunc() day buckets, min() and " +
        "countDistinct() aggregates. The CTE-to-CTE join is still an inline " +
        "FROM fragment — the builder joins tables, not two CTEs.",
      live: true,
    },
    {
      id: "06",
      title: "Funnel analysis",
      contract: "06-funnel-analysis",
      implementation: "hybrid",
      statements: [funnelAnalysis(db)],
      v08PainPoint:
        "Now builder-native: filter() supplies the typed first-event helpers " +
        "(min() filtered per kind) and count() filter() the funnel counts. The " +
        "`viewed_at + '1 day'::interval` windows stay inline interval fragments.",
      live: true,
    },
    {
      id: "07",
      title: "Recursive comments",
      contract: "07-recursive-comments",
      implementation: "hybrid",
      statements: [recursiveComments(db)],
      v08PainPoint:
        "Now builder-native: $withRecursive() drives the base UNION ALL step " +
        "with the self-reference in from(self) and the depth guard in WHERE. " +
        "The path/depth expressions (lpad, ||, ::text) stay inline fragments.",
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
        "Now builder-native: jsonTable() is the set-returning projection IR " +
        "(jsonb_to_recordset with a typed column list). The lateral cross-join " +
        "of the base table and the function stays an inline FROM fragment.",
      live: true,
    },
    {
      id: "11",
      title: "Generated columns and indexes",
      contract: "11-generated-columns-indexes",
      implementation: "raw-ddl",
      statements: generatedColumnDdl(),
      v08PainPoint:
        "Now expressible in the schema snapshot: the DDL is generated from a " +
        "defineTable() with a stored generated column plus a partial expression " +
        "index, then emitted by the PostgreSQL DDL generator (still raw DDL " +
        "because it comes from a snapshot, not a query builder).",
      live: true,
    },
    {
      id: "12",
      title: "MySQL compatibility",
      contract: "12-mysql-compatibility",
      implementation: "linked",
      statements: [],
      v08PainPoint:
        "Covered by the MySQL-family example; kept here as a cross-reference.",
      live: false,
    },
  ];
}

export function renderAdvancedSqlCases(
  identity: DialectIdentity = { dialect: "postgres" },
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

function windowAnalytics(db: Database): Sql {
  const h = hourlyStats.columns;
  // Reuse the ranking window so ORDER BY sorts by the same expression the
  // `engagement_rank` column exposes (no output-alias reference needed).
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
      // The gap test is PostgreSQL interval arithmetic with an exact boundary
      // (`> 30:00`), which dateDiff()'s whole-unit truncation cannot reproduce,
      // so it stays an inline fragment; the "30 minutes" literal still binds.
      starts_new_session: sql`case
        when ${ordered.previous_at} is null
          or ${ordered.occurred_at} - ${ordered.previous_at} > ${"30 minutes"}::interval
        then 1
        else 0
      end`,
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
  const firstSeen = db.$with("first_seen").as(
    db.select({
      actor_id: e.actor_id,
      cohort_day: dateTrunc("day", min(e.occurred_at)),
    }).from(events).groupBy(e.actor_id),
  );
  const activity = db.$with("activity").as(
    db.select({
      actor_id: e.actor_id,
      activity_day: dateTrunc("day", e.occurred_at),
    }).from(events).where(gte(e.occurred_at, FROM)),
  );
  // The builder joins tables, not two CTEs, so the CTE-to-CTE join is an inline
  // FROM fragment; everything else (aggregates, GROUP BY, ORDER BY) is builder.
  return db.with(firstSeen, activity).select({
    cohort_day: firstSeen.cohort_day,
    activity_day: activity.activity_day,
    retained_actors: countDistinct(activity.actor_id),
  }).from(
    sql`${identifier(firstSeen.actor_id.tableName)} inner join ${
      identifier(activity.actor_id.tableName)
    } on ${activity.actor_id} = ${firstSeen.actor_id}`,
  ).groupBy(firstSeen.cohort_day, activity.activity_day)
    .orderBy(asc(firstSeen.cohort_day), asc(activity.activity_day))
    .toSql();
}

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
  const fe = firstEvents;
  return db.with(firstEvents).select({
    viewed: filter(count(), isNotNull(fe.viewed_at)),
    // The `+ '1 day'::interval` deadline is PostgreSQL interval arithmetic, so
    // these two funnel steps stay inline count() filters; the literal binds.
    voted_within_day: sql`count(*) filter (
      where ${fe.voted_at} is not null
        and ${fe.voted_at} <= ${fe.viewed_at} + ${"1 day"}::interval
    )`,
    commented_within_day: sql`count(*) filter (
      where ${fe.commented_at} is not null
        and ${fe.commented_at} <= ${fe.viewed_at} + ${"1 day"}::interval
    )`,
  }).from(firstEvents).toSql();
}

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
      path: sql`lpad(${c.id}::text, 8, '0')`,
    }).from(comments).where(eq(c.id, 1))
      .unionAll(
        db.select({
          id: c.id,
          parent_id: c.parent_id,
          body: c.body,
          depth: sql`${self.depth} + 1`,
          path: sql`${self.path} || '.' || lpad(${c.id}::text, 8, '0')`,
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
    values (${"hourly-rollup"}, ${UNTIL}, now())
    on conflict (name) do update set
      high_watermark = excluded.high_watermark,
      updated_at = excluded.updated_at
  `;
}

function jsonTableExtraction(db: Database): Sql {
  const d = documents.columns;
  const items = jsonTable(d.payload, {
    sku: { type: "text", path: "$.sku" },
    qty: { type: "integer", path: "$.qty" },
  }, { as: "item", path: "$.items" });
  // jsonTable() is the set-returning projection IR; the base table joins the
  // function through an inline FROM (PostgreSQL applies LATERAL to functions
  // implicitly, so this is the documented lateral cross-join composition).
  return db.select({
    document_id: d.id,
    sku: items.columns.sku,
    qty: items.columns.qty,
  }).from(sql`${identifier(documents.name)}, ${items.from}`)
    .where(eq(d.id, 1))
    .toSql();
}

function generatedColumnDdl(): readonly Sql[] {
  // Generated from the schema snapshot rather than hand-written: the stored
  // generated column and the partial expression index both live on the
  // `documents` table definition and are emitted by the PostgreSQL DDL
  // generator (additive CREATE TABLE + CREATE INDEX only).
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [documents],
  });
  return generatePostgresUpStatements(snapshot).statements.map((statement) =>
    raw(statement)
  );
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
