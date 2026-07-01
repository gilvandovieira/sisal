-- 0002_bucket_functions.sql
-- app.bucket_5m(p_at timestamptz) -> timestamptz
--
-- Normalizes a timestamp to the start of its 5-minute bucket:
--
--   12:00:00 .. 12:04:59  =>  12:00:00
--   12:05:00 .. 12:09:59  =>  12:05:00
--   12:10:00 .. 12:14:59  =>  12:10:00
--
-- Implementation: floor the absolute epoch seconds to a multiple of 300 and
-- turn it back into a timestamp. extract(epoch ...) is the absolute seconds
-- since 1970-01-01 UTC and to_timestamp(double) is deterministic, so the
-- function depends ONLY on its argument and is safely IMMUTABLE.
--
-- 5 minutes is a product choice: small enough that "the last 15 minutes" has
-- real resolution (three buckets), large enough that a busy post does not
-- create a row per event. Tune BUCKET_SECONDS for your traffic.

create schema if not exists app;

create or replace function app.bucket_5m(p_at timestamptz)
returns timestamptz
language sql
immutable
as $$
  select to_timestamp(floor(extract(epoch from p_at) / 300.0) * 300.0);
$$;
