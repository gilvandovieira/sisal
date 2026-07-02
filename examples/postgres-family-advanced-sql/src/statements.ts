import {
  and,
  asc,
  count,
  createDatabase,
  type Database,
  dateTrunc,
  desc,
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

import { events, hourlyStats, jobs } from "./schema.ts";

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
      implementation: "raw",
      statements: [windowAnalytics()],
      v08PainPoint: "Needs core over(), frame, ranking, and window helpers.",
      live: true,
    },
    {
      id: "03",
      title: "Sessionization",
      contract: "03-sessionization",
      implementation: "raw",
      statements: [sessionization()],
      v08PainPoint: "Needs lag(), window aliasing, and portable date-diff.",
      live: true,
    },
    {
      id: "04",
      title: "Top-N per group",
      contract: "04-top-n-per-group",
      implementation: "raw",
      statements: [topNPerGroup()],
      v08PainPoint: "Needs row_number() plus a CTE/window expression builder.",
      live: true,
    },
    {
      id: "05",
      title: "Cohort retention",
      contract: "05-cohort-retention",
      implementation: "raw",
      statements: [cohortRetention()],
      v08PainPoint: "Needs date-diff, reusable CTE assembly, and aliases.",
      live: true,
    },
    {
      id: "06",
      title: "Funnel analysis",
      contract: "06-funnel-analysis",
      implementation: "hybrid",
      statements: [funnelAnalysis()],
      v08PainPoint: "Needs typed first-event helpers and alias reuse.",
      live: true,
    },
    {
      id: "07",
      title: "Recursive comments",
      contract: "07-recursive-comments",
      implementation: "raw",
      statements: [recursiveComments()],
      v08PainPoint: "Needs a WITH RECURSIVE builder and depth/cycle guards.",
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
      implementation: "raw",
      statements: [jsonTableExtraction()],
      v08PainPoint: "Needs JSON set-returning function/table projection IR.",
      live: true,
    },
    {
      id: "11",
      title: "Generated columns and indexes",
      contract: "11-generated-columns-indexes",
      implementation: "raw-ddl",
      statements: generatedColumnDdl(),
      v08PainPoint:
        "Needs generated columns, partial indexes, and expression indexes in schema snapshots.",
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

function sessionization(): Sql {
  return sql`
    with ordered as (
      select
        actor_id,
        occurred_at,
        lag(occurred_at) over (
          partition by actor_id
          order by occurred_at
        ) as previous_at
      from sisal_adv_events
      where occurred_at >= ${FROM}
    ),
    flagged as (
      select
        actor_id,
        occurred_at,
        case
          when previous_at is null
            or occurred_at - previous_at > ${"30 minutes"}::interval
          then 1
          else 0
        end as starts_new_session
      from ordered
    )
    select
      actor_id,
      occurred_at,
      sum(starts_new_session) over (
        partition by actor_id
        order by occurred_at
      ) as session_number
    from flagged
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

function cohortRetention(): Sql {
  return sql`
    with first_seen as (
      select
        actor_id,
        date_trunc('day', min(occurred_at)) as cohort_day
      from sisal_adv_events
      group by actor_id
    ),
    activity as (
      select
        e.actor_id,
        date_trunc('day', e.occurred_at) as activity_day
      from sisal_adv_events e
      where e.occurred_at >= ${FROM}
    )
    select
      f.cohort_day,
      a.activity_day,
      count(distinct a.actor_id) as retained_actors
    from first_seen f
    join activity a on a.actor_id = f.actor_id
    group by f.cohort_day, a.activity_day
    order by f.cohort_day, a.activity_day
  `;
}

function funnelAnalysis(): Sql {
  return sql`
    with first_events as (
      select
        actor_id,
        min(occurred_at) filter (where kind = ${"view"}) as viewed_at,
        min(occurred_at) filter (where kind = ${"vote"}) as voted_at,
        min(occurred_at) filter (where kind = ${"comment"}) as commented_at
      from sisal_adv_events
      where occurred_at >= ${FROM}
      group by actor_id
    )
    select
      count(*) filter (where viewed_at is not null) as viewed,
      count(*) filter (
        where voted_at is not null
          and voted_at <= viewed_at + ${"1 day"}::interval
      ) as voted_within_day,
      count(*) filter (
        where commented_at is not null
          and commented_at <= viewed_at + ${"1 day"}::interval
      ) as commented_within_day
    from first_events
  `;
}

function recursiveComments(): Sql {
  return sql`
    with recursive thread as (
      select
        id,
        parent_id,
        body,
        0 as depth,
        lpad(id::text, 8, '0') as path
      from sisal_adv_comments
      where id = ${1}

      union all

      select
        c.id,
        c.parent_id,
        c.body,
        thread.depth + 1 as depth,
        thread.path || '.' || lpad(c.id::text, 8, '0') as path
      from sisal_adv_comments c
      join thread on c.parent_id = thread.id
      where thread.depth < ${8}
    )
    select id, parent_id, body, depth
    from thread
    order by path
  `;
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

function jsonTableExtraction(): Sql {
  return sql`
    select
      d.id as document_id,
      item.sku,
      item.qty
    from sisal_adv_documents d
    cross join lateral jsonb_to_recordset(d.payload -> 'items')
      as item(sku text, qty integer)
    where d.id = ${1}
  `;
}

function generatedColumnDdl(): readonly Sql[] {
  return [
    sql`
      create table if not exists sisal_adv_documents (
        id integer primary key,
        payload jsonb not null,
        title_text text generated always as (payload ->> 'title') stored
      )
    `,
    sql`
      create index if not exists sisal_adv_documents_title_idx
        on sisal_adv_documents (lower(title_text))
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
