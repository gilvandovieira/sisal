/**
 * Typed `defineTable` models for posts and votes — **and** the stored functions
 * (`schemaObjects`), so this file is the single source of truth for the whole
 * database shape. `src/migrate.ts` generates the full init DDL (tables, DESC
 * indexes, the CHECK, and both PostgreSQL functions) from this snapshot; there
 * are no hand-written `.sql` migration files.
 *
 * This became possible across v0.4.0 → v0.5.0: rich indexes express DESC
 * ordering, `check(...)` expresses the constraint, `.default(sql\`…\`)` expresses
 * the `gen_random_uuid()` / `now()` server defaults, and `schemaObjects`
 * carries the functions. Column keys are snake_case so they line up 1:1 with the
 * raw SQL in `app.vote_post` (`RETURNS TABLE` columns) and the typed builder.
 *
 * @module
 */

import {
  check,
  columns,
  defineTable,
  desc,
  index,
  type InferSelect,
  primaryKey,
  type SisalSchemaObjectSnapshot,
  sql,
} from "@sisal/orm";

/** A row in `posts`, as read back from the database. */
export const posts = defineTable("posts", {
  id: columns.uuid().primaryKey().default(sql`gen_random_uuid()`),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  status: columns.text().notNull().default("published"),
  score: columns.integer().notNull().default(0),
  upvotes: columns.integer().notNull().default(0),
  downvotes: columns.integer().notNull().default(0),
  hot_score: columns.doublePrecision().notNull().default(0),
  created_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(sql`now()`),
  updated_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(sql`now()`),
}, (c) => [
  // Keyset feed indexes: leading equality column, then DESC tiebreakers — now
  // the typed model emits the same `... desc` DDL as migrations/0001_init.sql.
  index("posts_new_feed_idx").on(c.status, desc(c.created_at), desc(c.id)),
  index("posts_hot_feed_idx")
    .on(c.status, desc(c.hot_score), desc(c.created_at), desc(c.id)),
]);

/** A row in `post_votes`; only -1 / 1 are ever stored (0 means delete). */
export const postVotes = defineTable("post_votes", {
  post_id: columns.uuid().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  user_id: columns.uuid().notNull(),
  value: columns.smallint().notNull(),
  created_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(sql`now()`),
  updated_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(sql`now()`),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.user_id] }),
  check("post_votes_value_check", sql`value in (-1, 1)`),
  index("post_votes_user_idx").on(c.user_id),
  index("post_votes_post_idx").on(c.post_id),
]);

/** Inferred select-row type for a post. */
export type Post = InferSelect<typeof posts>;

/**
 * The stored DDL this example needs beyond tables/indexes: the `app` schema and
 * the two PostgreSQL functions. Carried in the snapshot as `schemaObjects` (a
 * v0.5.0 capability), they emit **after** the tables, so the whole database —
 * tables, indexes, checks, AND functions — regenerates from this one file (see
 * src/migrate.ts). `app.vote_post` is declared after `app.calculate_hot_score`
 * because it calls it.
 */
export const schemaObjects: readonly SisalSchemaObjectSnapshot[] = [
  {
    name: "app_schema",
    kind: "extension",
    dialect: "postgres",
    up: "create schema if not exists app;",
    down: "drop schema if exists app cascade;",
  },
  {
    name: "app.calculate_hot_score",
    kind: "function",
    dialect: "postgres",
    // A Reddit-inspired ranking value, deterministic in (score, created_at) so
    // it is safe to store + index. order = log10(max(|score|, 1)); sign by
    // score; age decays from HOT_EPOCH (2024-01-01) over ~12.5h periods.
    up: `create or replace function app.calculate_hot_score(
  p_score integer,
  p_created_at timestamptz
) returns double precision
language sql
immutable
as $$
  select
    sign(p_score)::double precision
      * log(10, greatest(abs(p_score), 1)::numeric)::double precision
    + (extract(epoch from p_created_at) - 1704067200) / 45000.0;
$$;`,
    down:
      "drop function if exists app.calculate_hot_score(integer, timestamptz);",
  },
  {
    name: "app.vote_post",
    kind: "function",
    dialect: "postgres",
    // The multi-step vote (read previous vote, upsert/delete it, recompute the
    // post's aggregates + hot_score) collapsed into ONE atomic database call.
    up: `create or replace function app.vote_post(
  p_post_id uuid,
  p_user_id uuid,
  p_value smallint
) returns table (
  id uuid,
  score integer,
  upvotes integer,
  downvotes integer,
  hot_score double precision
)
language plpgsql
as $$
declare
  v_old smallint;
  v_up_delta integer := 0;
  v_down_delta integer := 0;
begin
  if p_value not in (-1, 0, 1) then
    raise exception 'invalid vote value: % (expected -1, 0, or 1)', p_value
      using errcode = '22023';
  end if;

  select pv.value into v_old
  from public.post_votes pv
  where pv.post_id = p_post_id and pv.user_id = p_user_id
  for update;

  if p_value = 0 then
    if v_old is not null then
      delete from public.post_votes
      where post_id = p_post_id and user_id = p_user_id;

      if v_old = 1 then
        v_up_delta := -1;
      else
        v_down_delta := -1;
      end if;
    end if;
  else
    insert into public.post_votes (post_id, user_id, value)
    values (p_post_id, p_user_id, p_value)
    on conflict (post_id, user_id)
    do update set value = excluded.value, updated_at = now();

    if v_old is null then
      if p_value = 1 then
        v_up_delta := 1;
      else
        v_down_delta := 1;
      end if;
    elsif v_old <> p_value then
      if p_value = 1 then
        v_up_delta := 1;
        v_down_delta := -1;
      else
        v_up_delta := -1;
        v_down_delta := 1;
      end if;
    end if;
  end if;

  return query
  update public.posts p
  set
    upvotes = p.upvotes + v_up_delta,
    downvotes = p.downvotes + v_down_delta,
    score = (p.upvotes + v_up_delta) - (p.downvotes + v_down_delta),
    hot_score = app.calculate_hot_score(
      (p.upvotes + v_up_delta) - (p.downvotes + v_down_delta),
      p.created_at
    ),
    updated_at = now()
  where p.id = p_post_id
  returning p.id, p.score, p.upvotes, p.downvotes, p.hot_score;
end;
$$;`,
    down: "drop function if exists app.vote_post(uuid, uuid, smallint);",
  },
];
