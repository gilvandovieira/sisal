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
  OrmError,
  raw,
  renderSql,
  type Sql,
  sql,
} from "@sisal/orm";

import { events, hourlyStats, jobs, posts } from "./schema.ts";

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
      v08PainPoint:
        "Needs lag(), portable date-diff, and reusable window specs.",
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
      v08PainPoint:
        "Needs portable cohort/date-bucket helpers and alias reuse.",
      live: true,
    },
    {
      id: "06",
      title: "Funnel analysis",
      contract: "06-funnel-analysis",
      implementation: "hybrid",
      statements: [funnelAnalysis()],
      v08PainPoint: "Needs typed first-event helpers and CASE/FILTER parity.",
      live: true,
    },
    {
      id: "07",
      title: "Recursive comments",
      contract: "07-recursive-comments",
      implementation: "raw",
      statements: [recursiveComments()],
      v08PainPoint:
        "Needs a WITH RECURSIVE builder and version capability gates.",
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
      v08PainPoint: "Needs JSON_TABLE/set-returning projection IR.",
      live: true,
    },
    {
      id: "11",
      title: "Generated columns and indexes",
      contract: "11-generated-columns-indexes",
      implementation: "raw-ddl",
      statements: generatedColumnDdl(),
      v08PainPoint:
        "Generated columns work, but partial indexes are impossible on MySQL and need a typed capability error.",
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
            or timestampdiff(minute, previous_at, occurred_at) > ${30}
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
      select actor_id, date(min(occurred_at)) as cohort_day
      from sisal_adv_events
      group by actor_id
    ),
    activity as (
      select actor_id, date(occurred_at) as activity_day
      from sisal_adv_events
      where occurred_at >= ${FROM}
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
        min(case when kind = ${"view"} then occurred_at end) as viewed_at,
        min(case when kind = ${"vote"} then occurred_at end) as voted_at,
        min(case when kind = ${"comment"} then occurred_at end) as commented_at
      from sisal_adv_events
      where occurred_at >= ${FROM}
      group by actor_id
    )
    select
      sum(case when viewed_at is not null then 1 else 0 end) as viewed,
      sum(case
        when voted_at is not null
          and voted_at <= timestampadd(day, ${1}, viewed_at)
        then 1 else 0
      end) as voted_within_day,
      sum(case
        when commented_at is not null
          and commented_at <= timestampadd(day, ${1}, viewed_at)
        then 1 else 0
      end) as commented_within_day
    from first_events
  `;
}

function recursiveComments(): Sql {
  return sql`
    with recursive thread (id, parent_id, body, depth, path) as (
      select
        id,
        parent_id,
        body,
        0 as depth,
        cast(lpad(cast(id as char), 8, '0') as char(512)) as path
      from sisal_adv_comments
      where id = ${1}

      union all

      select
        c.id,
        c.parent_id,
        c.body,
        thread.depth + 1 as depth,
        concat(thread.path, '.', lpad(cast(c.id as char), 8, '0')) as path
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
    values (${"hourly-rollup"}, ${UNTIL}, now(6))
    on duplicate key update
      high_watermark = values(high_watermark),
      updated_at = values(updated_at)
  `;
}

function jsonTableExtraction(): Sql {
  return sql`
    select
      d.id as document_id,
      item.sku,
      item.qty
    from sisal_adv_documents d
    join json_table(
      d.payload,
      '$.items[*]' columns (
        sku varchar(64) path '$.sku',
        qty int path '$.qty'
      )
    ) as item
    where d.id = ${1}
  `;
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
