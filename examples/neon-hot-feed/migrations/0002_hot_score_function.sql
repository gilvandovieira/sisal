-- 0002_hot_score_function.sql
-- app.calculate_hot_score(score, created_at) -> double precision
--
-- A Reddit-inspired ranking value. It depends ONLY on its two arguments, never
-- on now(), so it is deterministic for a given post and is marked IMMUTABLE.
-- That is what makes it safe to store in posts.hot_score and to index, instead
-- of recomputing "score / age" on every read.
--
--   order = log10(max(abs(score), 1))
--   sign  = +1 if score > 0, -1 if score < 0, else 0
--   age   = (epoch(created_at) - HOT_EPOCH_SECONDS) / HOT_DECAY_SECONDS
--   hot   = sign * order + age
--
-- HOT_EPOCH_SECONDS = 1704067200  (2024-01-01T00:00:00Z)
-- HOT_DECAY_SECONDS = 45000       (~12.5h; one decay period ~= one order of
--                                  magnitude of votes)
--
-- IMMUTABLE note: extract(epoch from <timestamptz>) is the absolute number of
-- seconds since 1970-01-01 UTC and is independent of the session time zone, so
-- this function is genuinely deterministic and the IMMUTABLE label is sound.
-- (The TypeScript mirror of this function lives in src/hot.ts and is unit
-- tested against the same constants.)

create schema if not exists app;

create or replace function app.calculate_hot_score(
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
$$;
