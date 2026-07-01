-- 0004_rising_score_functions.sql
-- app.calculate_rising_score(post, p_now)        -> double precision  (pure read)
-- app.recompute_post_rising_score(post, p_now)   -> updated post row  (store one)
-- app.recompute_all_rising_scores(p_now)         -> integer           (store all)
--
-- RISING vs HOT. A hot score is roughly stable for a given (score, created_at):
-- it answers "what is good and recent?". A rising score answers "what is
-- gaining attention RIGHT NOW?", so it is TIME-DEPENDENT and must be recomputed
-- as the clock moves. That is why p_now is an explicit argument here and is
-- NEVER read via now() inside the math: callers pin it, which makes seeding and
-- tests deterministic and the time-dependence obvious.
--
-- MOVING-WINDOW MODEL (over the per-bucket activity_score):
--
--   last_15m   = sum(activity_score) for buckets in [p_now-15m,  p_now]
--   last_60m   = sum(activity_score) for buckets in [p_now-60m,  p_now]
--   prev_60m   = sum(activity_score) for buckets in [p_now-120m, p_now-60m)
--   accel      = greatest(last_15m - prev_60m / 4.0, 0)   -- heating up vs. last hour
--   rising     = last_15m * 3 + last_60m + accel * 2
--
-- Window boundaries are INCLUSIVE of p_now and exclude any bucket after it
-- (bucket_start > p_now), matching the TypeScript mirror in src/rising.ts. In
-- normal operation no bucket is ever in the future relative to p_now, but a
-- recompute pinned to an earlier p_now (or clock skew) could produce one, and it
-- must not inflate last_15m / last_60m.
--
-- last_15m dominates (recency matters most); last_60m adds broader context;
-- accel rewards a post accelerating now relative to the previous hour's pace
-- (prev_60m / 4 puts the previous hour on the same 15-minute footing). Reports
-- are already negative inside activity_score, so a report spike pulls every
-- term down. This is STABLE (reads tables, depends on p_now), not IMMUTABLE.

create schema if not exists app;

create or replace function app.calculate_rising_score(
  p_post_id uuid,
  p_now timestamptz
) returns double precision
language sql
stable
as $$
  with w as (
    select
      coalesce(sum(activity_score) filter (
        where bucket_start >= p_now - interval '15 minutes'
          and bucket_start <= p_now
      ), 0) as last_15m,
      coalesce(sum(activity_score) filter (
        where bucket_start >= p_now - interval '60 minutes'
          and bucket_start <= p_now
      ), 0) as last_60m,
      coalesce(sum(activity_score) filter (
        where bucket_start >= p_now - interval '120 minutes'
          and bucket_start < p_now - interval '60 minutes'
      ), 0) as prev_60m
    from post_activity_buckets
    where post_id = p_post_id
      -- Only buckets that can affect any window. The lower bound (120m) drops
      -- old buckets as p_now advances (why the score is time-dependent); the
      -- upper bound keeps a future bucket out of every window. Each FILTER above
      -- also bounds its own upper edge at p_now, so the result is correct even
      -- without this line — it just avoids scanning future rows.
      and bucket_start >= p_now - interval '120 minutes'
      and bucket_start <= p_now
  )
  select
      w.last_15m * 3.0
    + w.last_60m
    + greatest(w.last_15m - w.prev_60m / 4.0, 0) * 2.0
  from w;
$$;

-- Store the rising score for one post at p_now.
create or replace function app.recompute_post_rising_score(
  p_post_id uuid,
  p_now timestamptz default now()
) returns table (
  id uuid,
  rising_score double precision,
  rising_score_updated_at timestamptz
)
language plpgsql
as $$
begin
  return query
  update posts p
  set
    rising_score = app.calculate_rising_score(p.id, p_now),
    rising_score_updated_at = p_now,
    updated_at = now()
  where p.id = p_post_id
  returning p.id, p.rising_score, p.rising_score_updated_at;
end;
$$;

-- Store the rising score for every published post at p_now; return the count.
-- This is the "no background worker required" path: call it on a schedule, or
-- from `deno task recompute`, or right after recording activity in the demo.
create or replace function app.recompute_all_rising_scores(
  p_now timestamptz default now()
) returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  update posts p
  set
    rising_score = app.calculate_rising_score(p.id, p_now),
    rising_score_updated_at = p_now,
    updated_at = now()
  where p.status = 'published';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
