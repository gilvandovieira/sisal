-- Activity-vectors example schema (idempotent; safe to re-run).
--
-- The full computation chain, raw → consolidated:
--   post_events                  raw activity events (the source of truth, kept
--                                short-term; pruned after consolidation)
--   post_activity_buckets        hourly counters folded from events
--   post_activity_stats          one consolidated feature row per post
--                                (named columns + window-function moving avgs)
--   post_activity_daily          daily rollup (retention tier 2)
--   post_activity_monthly        monthly rollup (retention tier 3)
--
-- IDs are bigint/bigserial. All timestamps are timestamptz. Everything is
-- computed at an explicit p_now, never the wall clock, so it is deterministic.
-- This is a deterministic SQL **analytics** model (set-based batch computation),
-- NOT pgvector / embeddings — the "vector" is an ordered numeric projection of
-- the named columns below.

create table if not exists posts (
  id bigserial primary key,
  title text not null,
  body text,
  status text not null default 'published',
  hot_score double precision not null default 0,
  rising_score double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Raw events. One row per action. `value` allows weighted events (default 1).
create table if not exists post_events (
  id bigserial primary key,
  post_id bigint not null references posts (id) on delete cascade,
  actor_id bigint,
  event_type text not null,
  value integer not null default 1,
  created_at timestamptz not null default now()
);

-- Hourly buckets, folded from events by app.fold_events_to_buckets.
create table if not exists post_activity_buckets (
  post_id bigint not null references posts (id) on delete cascade,
  bucket_start timestamptz not null,
  votes integer not null default 0,
  comments integer not null default 0,
  reports integer not null default 0,
  unique_actors integer not null default 0,
  primary key (post_id, bucket_start)
);

-- The consolidated feature row: each feature is its own typed, queryable column.
-- The activity vector is an ordered projection of these (see
-- app.post_activity_vector); we store named columns, NOT a vector column.
create table if not exists post_activity_stats (
  post_id bigint primary key references posts (id) on delete cascade,
  votes_1h integer not null,
  comments_1h integer not null,
  reports_1h integer not null,
  unique_actors_1h integer not null,
  vote_ma_6h double precision not null,
  comment_ma_6h double precision not null,
  hot_score double precision not null,
  rising_score double precision not null,
  age_minutes double precision not null,
  computed_at timestamptz not null
);

-- Retention tier 2: daily rollup of the hourly buckets.
create table if not exists post_activity_daily (
  post_id bigint not null references posts (id) on delete cascade,
  day_start timestamptz not null,
  votes integer not null default 0,
  comments integer not null default 0,
  reports integer not null default 0,
  unique_actors integer not null default 0,
  active_hours integer not null default 0,
  primary key (post_id, day_start)
);

-- Retention tier 3: monthly rollup of the daily rollups.
create table if not exists post_activity_monthly (
  post_id bigint not null references posts (id) on delete cascade,
  month_start timestamptz not null,
  votes integer not null default 0,
  comments integer not null default 0,
  reports integer not null default 0,
  unique_actors integer not null default 0,
  active_days integer not null default 0,
  primary key (post_id, month_start)
);

create index if not exists posts_created_idx
  on posts (status, created_at desc, id desc);

create index if not exists post_events_post_created_idx
  on post_events (post_id, created_at);

-- Pruning old events scans by time, so index created_at.
create index if not exists post_events_created_idx
  on post_events (created_at);

create index if not exists post_activity_buckets_post_bucket_idx
  on post_activity_buckets (post_id, bucket_start desc);
