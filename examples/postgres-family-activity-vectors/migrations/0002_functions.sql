-- Activity-vectors example: the SQL computation engine (raw-SQL part).
--
-- Only the shapes Sisal genuinely has no builder for remain SQL functions:
-- window-function moving averages (compute_post_activity_stats), the ARRAY[...]
-- vector projection, and unnest WITH ORDINALITY cosine similarity (see the
-- README "Sisal API pressure points" — owned by the v0.7 analytics roadmap).
-- The events→buckets fold, the daily/monthly rollups, and the event pruning
-- were converted to builder statements in v0.6 (src/events.ts,
-- src/retention.ts): insert-from-select + FILTER + dateTrunc + upsert compose
-- through the typed builder now. Each remaining function is one set-based
-- statement over many rows — batch computation, not a row-by-row application
-- loop. The TypeScript side calls these by name and passes an explicit p_now.

create schema if not exists app;

-- 1. Compute the consolidated stats for every published post at p_now, in ONE
--    statement. Moving averages use a WINDOW (last 6 hourly buckets, rows-based
--    — exactly `rows between 5 preceding and current row`). votes_1h etc. come
--    from the current-hour bucket. Batch computation over the whole set.
--    WINDOW functions have no Sisal builder (the one hard wall the v0.6
--    readiness investigation confirmed — owned by v0.7).
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

-- 2. The activity vector: an ordered double precision[] projection of the named
--    columns. NOT a pgvector column — just an array for export/scoring/debug.
--    ARRAY[...] projection has no Sisal builder.
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

-- 3. Cosine similarity over two equal-length vectors (the secondary similarity
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
