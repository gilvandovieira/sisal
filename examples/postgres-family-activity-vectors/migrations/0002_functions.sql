-- Activity-vectors example: the SQL computation engine (raw-SQL part).
--
-- Sisal has no builder for CREATE FUNCTION, insert-from-select, window
-- functions, or array projection, so the whole computation chain is hand-written
-- SQL (see the README "Sisal API pressure points"). Every function is one
-- set-based statement over many rows — the point of the example is that this is
-- batch computation, not a row-by-row application loop. The TypeScript side just
-- calls these by name and passes an explicit p_now.

create schema if not exists app;

-- 1. Fold raw events in [p_from, p_until) into hourly buckets.
--    INSERT … SELECT … GROUP BY … ON CONFLICT (insert-from-select + FILTER).
create or replace function app.fold_events_to_buckets(
  p_from timestamptz,
  p_until timestamptz
)
returns integer
language sql
as $$
  with folded as (
    insert into post_activity_buckets (
      post_id, bucket_start, votes, comments, reports, unique_actors
    )
    select
      e.post_id,
      date_trunc('hour', e.created_at) as bucket_start,
      coalesce(sum(e.value) filter (where e.event_type = 'vote'), 0)::integer,
      coalesce(sum(e.value) filter (where e.event_type = 'comment'), 0)::integer,
      coalesce(sum(e.value) filter (where e.event_type = 'report'), 0)::integer,
      count(distinct e.actor_id)::integer as unique_actors
    from post_events e
    where e.created_at >= p_from
      and e.created_at < p_until
    group by e.post_id, date_trunc('hour', e.created_at)
    on conflict (post_id, bucket_start) do update set
      votes = excluded.votes,
      comments = excluded.comments,
      reports = excluded.reports,
      unique_actors = excluded.unique_actors
    returning post_id
  )
  select count(*)::integer from folded;
$$;

-- 2. Compute the consolidated stats for every published post at p_now, in ONE
--    statement. Moving averages use a WINDOW (last 6 hourly buckets, rows-based
--    — exactly `rows between 5 preceding and current row`). votes_1h etc. come
--    from the current-hour bucket. Batch computation over the whole set.
create or replace function app.compute_post_activity_stats(p_now timestamptz)
returns integer
language sql
as $$
  with moving as (
    select
      post_id,
      bucket_start,
      avg(votes::double precision) over w as vote_ma_6h,
      avg(comments::double precision) over w as comment_ma_6h,
      row_number() over (partition by post_id order by bucket_start desc)
        as recency
    from post_activity_buckets
    where bucket_start <= date_trunc('hour', p_now)
    window w as (
      partition by post_id
      order by bucket_start
      rows between 5 preceding and current row
    )
  ),
  latest_ma as (
    select post_id, vote_ma_6h, comment_ma_6h from moving where recency = 1
  ),
  current_hour as (
    select post_id, votes, comments, reports, unique_actors
    from post_activity_buckets
    where bucket_start = date_trunc('hour', p_now)
  ),
  upserted as (
    insert into post_activity_stats (
      post_id, votes_1h, comments_1h, reports_1h, unique_actors_1h,
      vote_ma_6h, comment_ma_6h, hot_score, rising_score, age_minutes,
      computed_at
    )
    select
      p.id,
      coalesce(c.votes, 0),
      coalesce(c.comments, 0),
      coalesce(c.reports, 0),
      coalesce(c.unique_actors, 0),
      coalesce(m.vote_ma_6h, 0),
      coalesce(m.comment_ma_6h, 0),
      p.hot_score,
      p.rising_score,
      (extract(epoch from (p_now - p.created_at)) / 60.0)::double precision,
      p_now
    from posts p
    left join current_hour c on c.post_id = p.id
    left join latest_ma m on m.post_id = p.id
    where p.status = 'published'
    on conflict (post_id) do update set
      votes_1h = excluded.votes_1h,
      comments_1h = excluded.comments_1h,
      reports_1h = excluded.reports_1h,
      unique_actors_1h = excluded.unique_actors_1h,
      vote_ma_6h = excluded.vote_ma_6h,
      comment_ma_6h = excluded.comment_ma_6h,
      hot_score = excluded.hot_score,
      rising_score = excluded.rising_score,
      age_minutes = excluded.age_minutes,
      computed_at = excluded.computed_at
    returning post_id
  )
  select count(*)::integer from upserted;
$$;

-- 3. The activity vector: an ordered double precision[] projection of the named
--    columns. NOT a pgvector column — just an array for export/scoring/debug.
--    DIMENSION ORDER (activity-v1) — keep in lockstep with src/vector.ts:
--    [votes_1h, comments_1h, reports_1h, unique_actors_1h,
--     vote_ma_6h, comment_ma_6h, hot_score, rising_score, age_minutes]
create or replace function app.post_activity_vector(p_post_id bigint)
returns double precision[]
language sql
stable
as $$
  select array[
    votes_1h::double precision,
    comments_1h::double precision,
    reports_1h::double precision,
    unique_actors_1h::double precision,
    vote_ma_6h,
    comment_ma_6h,
    hot_score,
    rising_score,
    age_minutes
  ]
  from post_activity_stats
  where post_id = p_post_id;
$$;

-- 4a. Retention tier 2: roll hourly buckets in [p_from, p_until) up to daily.
create or replace function app.rollup_daily(
  p_from timestamptz,
  p_until timestamptz
)
returns integer
language sql
as $$
  with rolled as (
    insert into post_activity_daily (
      post_id, day_start, votes, comments, reports, unique_actors, active_hours
    )
    select
      post_id,
      date_trunc('day', bucket_start) as day_start,
      sum(votes)::integer,
      sum(comments)::integer,
      sum(reports)::integer,
      sum(unique_actors)::integer,
      count(*)::integer as active_hours
    from post_activity_buckets
    where bucket_start >= p_from and bucket_start < p_until
    group by post_id, date_trunc('day', bucket_start)
    on conflict (post_id, day_start) do update set
      votes = excluded.votes,
      comments = excluded.comments,
      reports = excluded.reports,
      unique_actors = excluded.unique_actors,
      active_hours = excluded.active_hours
    returning post_id
  )
  select count(*)::integer from rolled;
$$;

-- 4b. Retention tier 3: roll daily rollups up to monthly.
create or replace function app.rollup_monthly(
  p_from timestamptz,
  p_until timestamptz
)
returns integer
language sql
as $$
  with rolled as (
    insert into post_activity_monthly (
      post_id, month_start, votes, comments, reports, unique_actors, active_days
    )
    select
      post_id,
      date_trunc('month', day_start) as month_start,
      sum(votes)::integer,
      sum(comments)::integer,
      sum(reports)::integer,
      sum(unique_actors)::integer,
      count(*)::integer as active_days
    from post_activity_daily
    where day_start >= p_from and day_start < p_until
    group by post_id, date_trunc('month', day_start)
    on conflict (post_id, month_start) do update set
      votes = excluded.votes,
      comments = excluded.comments,
      reports = excluded.reports,
      unique_actors = excluded.unique_actors,
      active_days = excluded.active_days
    returning post_id
  )
  select count(*)::integer from rolled;
$$;

-- 5. Retention: delete raw events older than p_before (after they've been
--    consolidated into buckets/rollups). Returns the number pruned.
create or replace function app.prune_events(p_before timestamptz)
returns integer
language sql
as $$
  with pruned as (
    delete from post_events where created_at < p_before returning id
  )
  select count(*)::integer from pruned;
$$;

-- 6. Cosine similarity over two equal-length vectors (the secondary similarity
--    payoff). unnest WITH ORDINALITY pairs dimensions by index; returns 0 for
--    zero-vector / mismatched cases. Documented as a raw-SQL pressure point.
create or replace function app.cosine_similarity(
  p_left double precision[],
  p_right double precision[]
)
returns double precision
language sql
immutable
as $$
  with pairs as (
    select l.val as lv, r.val as rv
    from unnest(p_left) with ordinality as l (val, idx)
    join unnest(p_right) with ordinality as r (val, idx) on l.idx = r.idx
  ),
  agg as (
    select
      sum(lv * rv) as dot,
      sqrt(sum(lv * lv)) as norm_left,
      sqrt(sum(rv * rv)) as norm_right
    from pairs
  )
  select case
    when coalesce(norm_left, 0) = 0 or coalesce(norm_right, 0) = 0 then 0
    else dot / (norm_left * norm_right)
  end
  from agg;
$$;
