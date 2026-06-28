-- 0003_vote_post_function.sql
-- app.vote_post(post_id, user_id, value) -> updated post row
--
-- The whole point of this example: a multi-step vote mutation (read previous
-- vote, upsert/delete it, recompute the post's aggregates and hot_score)
-- collapsed into ONE database call. Calling it as a single statement
--
--   select * from app.vote_post($1::uuid, $2::uuid, $3::smallint)
--
-- runs inside the server's implicit transaction, so it is atomic without an
-- interactive `db.transaction(async (tx) => { ... })` callback that would hold
-- a connection open across several round trips (awkward on Deno Deploy + Neon
-- HTTP mode). See the README "Important Neon note" for why this matters.

create schema if not exists app;

create or replace function app.vote_post(
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

  -- Previous vote for this (post, user). FOR UPDATE serializes concurrent
  -- votes by the SAME user on the same post.
  select pv.value into v_old
  from public.post_votes pv
  where pv.post_id = p_post_id and pv.user_id = p_user_id
  for update;

  if p_value = 0 then
    -- Vote removal is a DELETE; we never store a zero row.
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
      -- brand new vote
      if p_value = 1 then
        v_up_delta := 1;
      else
        v_down_delta := 1;
      end if;
    elsif v_old <> p_value then
      -- switched direction: one side goes up, the other goes down
      if p_value = 1 then
        v_up_delta := 1;
        v_down_delta := -1;
      else
        v_up_delta := -1;
        v_down_delta := 1;
      end if;
    end if;
    -- v_old = p_value: nothing changed, deltas stay 0.
  end if;

  -- Apply the deltas against the CURRENT row under lock (UPDATE re-reads the
  -- row), then recompute the stored, indexable hot_score from the new score.
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
$$;
