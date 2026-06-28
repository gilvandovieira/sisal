-- 0001_init.sql
-- Tables, constraints, and indexes for the Reddit-style hot feed.
--
-- This file is hand-written SQL on purpose. Sisal's snapshot DDL generator
-- (`generatePostgresUpStatements`) emits only additive `CREATE TABLE` /
-- `ADD COLUMN` statements; it does not express DESC index ordering, partial
-- indexes, CHECK constraints in this exact shape, or PostgreSQL functions.
-- The typed `defineTable` mirror in `src/schema.ts` exists for the query
-- builder; these `.sql` files are the source of truth for the database shape.

create schema if not exists app;

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  status text not null default 'published',
  score integer not null default 0,
  upvotes integer not null default 0,
  downvotes integer not null default 0,
  -- Stored, not computed-on-read: the hot score is stable for a given
  -- (score, created_at) pair, so it can be persisted and indexed. See
  -- src/hot.ts and 0002_hot_score_function.sql for the model.
  hot_score double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists post_votes (
  post_id uuid not null references posts (id) on delete cascade,
  user_id uuid not null,
  -- Only -1 / 1 are ever stored: removing a vote is a DELETE (value 0 in the
  -- app.vote_post function), never a stored zero row.
  value smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, user_id),
  constraint post_votes_value_check check (value in (-1, 1))
);

-- Keyset (cursor) pagination indexes. The column order and DESC direction
-- match the ORDER BY in src/queries.ts so the feeds are index-ordered scans.
create index if not exists posts_new_feed_idx
  on posts (status, created_at desc, id desc);

create index if not exists posts_hot_feed_idx
  on posts (status, hot_score desc, created_at desc, id desc);

create index if not exists post_votes_user_idx on post_votes (user_id);
create index if not exists post_votes_post_idx on post_votes (post_id);
