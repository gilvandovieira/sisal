-- 0003_activity_functions.sql
-- app.bucket_activity_score(...)  -> double precision  (weights)
-- app.record_post_activity(...)   -> updated bucket row (atomic recorder)
--
-- ACTIVITY WEIGHTS (product tuning, not a universal truth — adjust freely):
--
--   upvote        =  +1
--   downvote      =  -0.5
--   comment       =  +3     (writing > clicking; comments signal real interest)
--   unique actor  =  +2     (breadth of people > volume from one person)
--   report        =  -8     (a strong negative; spikes should sink a post fast)
--
-- These constants live in ONE place (app.bucket_activity_score) so the bucket
-- recorder and any backfill agree by construction. The TypeScript mirror in
-- src/rising.ts uses the same numbers and is unit-tested against them.

create schema if not exists app;

create or replace function app.bucket_activity_score(
  p_upvotes integer,
  p_downvotes integer,
  p_comments integer,
  p_unique_actors integer,
  p_reports integer
) returns double precision
language sql
immutable
as $$
  select
      p_upvotes * 1.0
    + p_downvotes * -0.5
    + p_comments * 3.0
    + p_unique_actors * 2.0
    + p_reports * -8.0;
$$;

-- app.record_post_activity records one activity event and returns the updated
-- bucket. The whole read-modify-write (dedupe the actor, bump the right
-- counter, bump unique_actors only on the actor's first touch, recompute the
-- bucket score) is ONE database call, so it is atomic inside the server's
-- implicit transaction. On normal PostgreSQL you could equally do this as an
-- interactive `db.transaction(tx => { ... })` (see
-- `recordPostActivityWithTransaction` in src/activity.ts and the README); the
-- function is preferred here because it keeps the multi-step mutation atomic and
-- database-local in a single round trip.
--
-- p_now/p_at is passed in (defaulting to now()) rather than read inside the
-- function: callers pin it so seeding and tests are deterministic.
create or replace function app.record_post_activity(
  p_post_id uuid,
  p_actor_id uuid,
  p_kind text,
  p_at timestamptz default now()
) returns table (
  post_id uuid,
  bucket_start timestamptz,
  upvotes integer,
  downvotes integer,
  comments integer,
  reports integer,
  unique_actors integer,
  activity_score double precision
)
language plpgsql
as $$
-- The RETURNS TABLE (post_id, bucket_start, …) output columns are in scope as
-- variables and share names with the table columns this body writes. Resolve
-- any ambiguity in favour of the COLUMN — the body never reads the output
-- variables by name (it uses p_* args, v_* locals, and qualified b.* in
-- RETURNING), so a bare `post_id` / `bucket_start` always means the column.
#variable_conflict use_column
declare
  v_bucket timestamptz;
  v_new_actor boolean;
  v_actor_delta integer;
  v_up integer := 0;
  v_down integer := 0;
  v_com integer := 0;
  v_rep integer := 0;
begin
  if p_kind not in ('upvote', 'downvote', 'comment', 'report') then
    raise exception
      'invalid activity kind: % (expected upvote, downvote, comment, report)',
      p_kind using errcode = '22023';
  end if;

  v_bucket := app.bucket_5m(p_at);

  -- Record the actor's presence in this (post, bucket). ON CONFLICT DO NOTHING
  -- makes the FIRST touch insert a row and every later touch a no-op; FOUND is
  -- true only when a row was actually inserted, i.e. this is a NEW actor here.
  insert into post_activity_actors (post_id, bucket_start, actor_id)
  values (p_post_id, v_bucket, p_actor_id)
  on conflict (post_id, bucket_start, actor_id) do nothing;
  v_new_actor := found;
  v_actor_delta := case when v_new_actor then 1 else 0 end;

  -- One counter moves per event kind.
  case p_kind
    when 'upvote' then v_up := 1;
    when 'downvote' then v_down := 1;
    when 'comment' then v_com := 1;
    when 'report' then v_rep := 1;
  end case;

  -- Upsert the bucket: create it on first activity, otherwise add the deltas.
  -- unique_actors only grows when this was the actor's first touch in the
  -- bucket. activity_score is recomputed from the post-update counters so the
  -- stored score and the counters never disagree.
  return query
  insert into post_activity_buckets as b (
    post_id, bucket_start, upvotes, downvotes, comments, reports,
    unique_actors, activity_score
  )
  values (
    p_post_id, v_bucket, v_up, v_down, v_com, v_rep, v_actor_delta,
    app.bucket_activity_score(v_up, v_down, v_com, v_actor_delta, v_rep)
  )
  on conflict (post_id, bucket_start) do update set
    upvotes = b.upvotes + v_up,
    downvotes = b.downvotes + v_down,
    comments = b.comments + v_com,
    reports = b.reports + v_rep,
    unique_actors = b.unique_actors + v_actor_delta,
    activity_score = app.bucket_activity_score(
      b.upvotes + v_up,
      b.downvotes + v_down,
      b.comments + v_com,
      b.unique_actors + v_actor_delta,
      b.reports + v_rep
    ),
    updated_at = now()
  returning
    b.post_id, b.bucket_start, b.upvotes, b.downvotes, b.comments,
    b.reports, b.unique_actors, b.activity_score;
end;
$$;
