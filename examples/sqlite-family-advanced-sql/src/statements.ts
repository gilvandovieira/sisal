import {
  and,
  count,
  createDatabase,
  type Database,
  dateTrunc,
  type DialectIdentity,
  eq,
  excluded,
  filter,
  gte,
  lt,
  raw,
  renderSql,
  type Sql,
  sql,
} from "@sisal/orm";

import { events, hourlyStats } from "./schema.ts";

export type AdvancedImplementation =
  | "builder"
  | "raw"
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
      implementation: "raw",
      statements: [windowAnalytics()],
      requires: "window",
      v08PainPoint:
        "Needs capability-gated over(), frame, and ranking helpers.",
      live: true,
    },
    {
      id: "03",
      title: "Sessionization",
      contract: "03-sessionization",
      implementation: "skipped",
      statements: [],
      v08PainPoint: "Skipped until portable date-diff/window helpers exist.",
      live: false,
    },
    {
      id: "04",
      title: "Top-N per group",
      contract: "04-top-n-per-group",
      implementation: "raw",
      statements: [topNPerGroup()],
      requires: "window",
      v08PainPoint: "Needs row_number() plus a CTE/window expression builder.",
      live: true,
    },
    {
      id: "05",
      title: "Cohort retention",
      contract: "05-cohort-retention",
      implementation: "skipped",
      statements: [],
      v08PainPoint:
        "Skipped until date-bucket/date-diff semantics are normalized.",
      live: false,
    },
    {
      id: "06",
      title: "Funnel analysis",
      contract: "06-funnel-analysis",
      implementation: "skipped",
      statements: [],
      v08PainPoint: "Skipped until first-event helpers and alias reuse land.",
      live: false,
    },
    {
      id: "07",
      title: "Recursive comments",
      contract: "07-recursive-comments",
      implementation: "raw",
      statements: [recursiveComments()],
      requires: "recursive",
      v08PainPoint: "Needs a WITH RECURSIVE builder and depth/cycle guards.",
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
      implementation: "raw",
      statements: [jsonTableExtraction()],
      requires: "json",
      v08PainPoint: "Needs JSON-table IR over json_each/json_extract.",
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
        "Needs generated columns and partial indexes in schema snapshots.",
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

function windowAnalytics(): Sql {
  return sql`
    select
      post_id,
      bucket,
      votes,
      avg(votes) over (
        partition by post_id
        order by bucket
        rows between 5 preceding and current row
      ) as vote_ma_6h,
      rank() over (
        partition by bucket
        order by engagement_score desc
      ) as engagement_rank
    from sisal_adv_hourly_stats
    where bucket >= ${FROM}
    order by bucket, engagement_rank
  `;
}

function topNPerGroup(): Sql {
  return sql`
    select post_id, bucket, engagement_score, rn
    from (
      select
        post_id,
        bucket,
        engagement_score,
        row_number() over (
          partition by post_id
          order by engagement_score desc, bucket desc
        ) as rn
      from sisal_adv_hourly_stats
      where bucket >= ${FROM}
    ) ranked
    where rn <= ${3}
  `;
}

function recursiveComments(): Sql {
  return sql`
    with recursive thread(id, parent_id, body, depth, path) as (
      select
        id,
        parent_id,
        body,
        0 as depth,
        printf('%08d', id) as path
      from sisal_adv_comments
      where id = ${1}

      union all

      select
        c.id,
        c.parent_id,
        c.body,
        thread.depth + 1 as depth,
        thread.path || '.' || printf('%08d', c.id) as path
      from sisal_adv_comments c
      join thread on c.parent_id = thread.id
      where thread.depth < ${8}
    )
    select id, parent_id, body, depth
    from thread
    order by path
  `;
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

function jsonTableExtraction(): Sql {
  return sql`
    select
      d.id as document_id,
      json_extract(item.value, '$.sku') as sku,
      json_extract(item.value, '$.qty') as qty
    from sisal_adv_documents d,
      json_each(d.payload, '$.items') as item
    where d.id = ${1}
  `;
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
