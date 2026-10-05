-- Multi-answer live chat.
--
-- Every multi-answer submission is also recorded as one row in answer_feed (who said what,
-- in order) so the host screen and phones can show a TikTok/Facebook-Live style chat next to
-- the bubbles. The bubbles and each player's own answer list keep using answers.answer.
--
-- Like every other table: RLS on, no policies, no grants. Only the SECURITY DEFINER
-- functions below can read or write it.

create table if not exists public.answer_feed (
  id bigint generated always as identity primary key,
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists answer_feed_question_idx on public.answer_feed (question_id, id desc);

alter table public.answer_feed enable row level security;
revoke all on public.answer_feed from anon, authenticated;

-- Answers sent before the chat existed still show up in it (oldest first).
insert into public.answer_feed (quiz_id, question_id, player_id, text, created_at)
select a.quiz_id, a.question_id, a.player_id, t.txt, a.answered_at
from public.answers a
join public.questions q on q.id = a.question_id and q.type = 'multi_answer'
cross join lateral jsonb_array_elements_text(a.answer) with ordinality as t(txt, n)
where a.answered_at is not null and jsonb_typeof(a.answer) = 'array'
  and not exists (select 1 from public.answer_feed f where f.question_id = a.question_id and f.player_id = a.player_id)
order by a.answered_at, a.id, t.n;

-- The most recent chat messages for a question, oldest first: [{id, name, text, is_me}].
create or replace function public.quizbro_feed(p_question_id uuid, p_me uuid default null, p_limit int default 30)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'name', p.name, 'text', f.text, 'is_me', f.player_id is not distinct from p_me
         ) order by f.id), '[]'::jsonb)
  from (
    select * from public.answer_feed
    where question_id = p_question_id
    order by id desc
    limit p_limit
  ) f
  join public.players p on p.id = f.player_id
$$;

create or replace function public.submit_answer(p_player_id uuid, p_question_id uuid, p_answer jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_player public.players;
  v_quiz public.quizzes;
  v_q public.questions;
  v_k public.question_keys;
  v_elapsed numeric;
  v_ok boolean;
  v_pts int := 0;
  v_n int;
  v_new jsonb;
  v_prev public.answers;
begin
  select * into v_player from public.players where id = p_player_id;
  if not found then raise exception 'Player not found'; end if;

  -- Serialises with host actions so an answer can't slip in after "reveal".
  select * into v_quiz from public.quizzes where id = v_player.quiz_id for update;
  if v_quiz.status <> 'question' then raise exception 'This question is closed'; end if;

  select * into v_q from public.questions
  where id = p_question_id and quiz_id = v_quiz.id and pos = v_quiz.current_pos;
  if not found then raise exception 'This question is closed'; end if;
  -- One second of grace for network latency.
  if now() > v_quiz.question_ends_at + interval '1 second' then
    raise exception 'Time is up';
  end if;
  -- Multi-answer is the exception: a player sends several answers, one at a time.
  if v_q.type <> 'multi_answer'
     and exists (select 1 from public.answers where player_id = p_player_id and question_id = p_question_id) then
    raise exception 'Already answered';
  end if;

  select * into v_k from public.question_keys where question_id = p_question_id;
  v_n := jsonb_array_length(v_q.options);

  if v_q.type = 'multi_answer' then
    -- Normally ONE answer (a json string); a list is also accepted. Each is validated, then
    -- appended to this player's row, with a short cooldown between sends.
    v_new := public.quizbro_clean_answers(
      case when jsonb_typeof(p_answer) = 'string' then jsonb_build_array(p_answer) else p_answer end,
      v_q.max_answers, v_q.max_chars);
    select * into v_prev from public.answers
      where player_id = p_player_id and question_id = p_question_id;
    if v_prev.id is not null then
      if jsonb_array_length(v_prev.answer) >= v_q.max_answers then
        raise exception 'You have used all your answers';
      end if;
      if jsonb_array_length(v_prev.answer) + jsonb_array_length(v_new) > v_q.max_answers then
        raise exception 'You only have % answer% left',
          v_q.max_answers - jsonb_array_length(v_prev.answer),
          case when v_q.max_answers - jsonb_array_length(v_prev.answer) = 1 then '' else 's' end;
      end if;
      -- Half a second of slack for network jitter; the client counts the full cooldown.
      if now() - v_prev.answered_at < make_interval(secs => public.quizbro_answer_cooldown() - 0.5) then
        raise exception 'Wait a moment before your next answer';
      end if;
      if exists (
        select 1
        from jsonb_array_elements_text(v_prev.answer) o
        cross join jsonb_array_elements_text(v_new) n
        where public.quizbro_norm(o) = public.quizbro_norm(n)
      ) then
        raise exception 'You already gave that answer';
      end if;
    end if;
    v_ok := null;
  elsif v_q.type = 'short_text' then
    if p_answer is null or jsonb_typeof(p_answer) <> 'string' or length(p_answer #>> '{}') > 200
       or length(trim(p_answer #>> '{}')) = 0 then
      raise exception 'Invalid answer';
    end if;
    v_ok := exists (
      select 1 from jsonb_array_elements_text(v_k.correct) c
      where lower(trim(c)) = lower(trim(p_answer #>> '{}'))
    );
  else
    if p_answer is null or jsonb_typeof(p_answer) <> 'array' or jsonb_array_length(p_answer) < 1
       or jsonb_array_length(p_answer) > v_n
       or exists (
         select 1 from jsonb_array_elements(p_answer) e
         where jsonb_typeof(e) <> 'number' or (e #>> '{}')::numeric <> floor((e #>> '{}')::numeric)
            or (e #>> '{}')::int < 0 or (e #>> '{}')::int >= v_n
       ) then
      raise exception 'Invalid answer';
    end if;
    if v_q.type <> 'multiple_select' and jsonb_array_length(p_answer) <> 1 then
      raise exception 'Invalid answer';
    end if;
    if v_q.type = 'poll' then
      v_ok := null;
    else
      v_ok := public.quizbro_int_set(p_answer) = public.quizbro_int_set(v_k.correct);
    end if;
  end if;

  -- Everyone's clock starts when the host opens the question; faster = more points.
  v_elapsed := extract(epoch from (now() - v_quiz.question_started_at));
  if v_ok then
    v_pts := round(v_q.points * (1 - 0.5 * least(1, greatest(0, v_elapsed / v_q.time_limit))));
  end if;

  if v_q.type = 'multi_answer' and v_prev.id is not null then
    -- answered_at doubles as "time of the latest answer", which drives the cooldown.
    update public.answers
    set answer = v_prev.answer || v_new, answered_at = now()
    where id = v_prev.id;
  else
    insert into public.answers (quiz_id, question_id, player_id, answer, is_correct, points, time_ms, answered_at)
    values (v_quiz.id, p_question_id, p_player_id,
            case when v_q.type = 'multi_answer' then v_new else p_answer end, v_ok, v_pts,
            least(round(v_elapsed * 1000), v_q.time_limit * 1000 + 1000)::int, now());
  end if;

  -- Chat feed: one row per answer, so the host screen and phones can show who said what, in order.
  if v_q.type = 'multi_answer' then
    insert into public.answer_feed (quiz_id, question_id, player_id, text)
    select v_quiz.id, p_question_id, p_player_id, x
    from jsonb_array_elements_text(v_new) with ordinality as t(x, n)
    order by n;
  end if;

  -- Everyone has answered (for multi-answer: everyone has used all their answers): close early.
  if now() < v_quiz.question_ends_at
     and (select count(*) from public.answers
          where question_id = p_question_id and answered_at is not null
            and case when v_q.type = 'multi_answer'
                     then jsonb_array_length(answer) >= v_q.max_answers
                     else true end)
         >= (select count(*) from public.players where quiz_id = v_quiz.id) then
    update public.quizzes set question_ends_at = now() where id = v_quiz.id;
  end if;

  return jsonb_build_object('accepted', true);
end $$;

create or replace function public.get_play_state(p_player_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_player public.players;
  v_quiz public.quizzes;
  v_total int;
  v_q public.questions;
  v_k public.question_keys;
  v_my public.answers;
  v_upto int;
  v_streak int := 0;
  v_limit int;
  v_lb jsonb;
  v_out jsonb;
  v_secs numeric := 0;
  v_closed boolean := false;
  r record;
begin
  select * into v_player from public.players where id = p_player_id;
  if not found then raise exception 'Player not found'; end if;
  select * into v_quiz from public.quizzes where id = v_player.quiz_id;
  select count(*) into v_total from public.questions where quiz_id = v_quiz.id;
  v_upto := public.quizbro_upto(v_quiz);
  v_limit := case v_quiz.status when 'reveal' then 5 when 'finished' then 10 else 0 end;

  -- Streak of consecutive correct answers among questions already revealed.
  for r in
    select q.type, a.is_correct
    from public.questions q
    left join public.answers a on a.question_id = q.id and a.player_id = p_player_id
    where q.quiz_id = v_quiz.id and q.pos <= v_upto
    order by q.pos desc
  loop
    if r.type in ('poll', 'multi_answer') then continue; end if;
    exit when r.is_correct is not true;
    v_streak := v_streak + 1;
  end loop;

  -- Scores only count questions the host has revealed, so a phone can't infer
  -- whether it was right before the reveal.
  with scores as (
    select p.id, p.name,
           coalesce(sum(a.points) filter (where qq.pos <= v_upto), 0)::int as score,
           count(*) filter (where a.is_correct and qq.pos <= v_upto) as correct
    from public.players p
    left join public.answers a on a.player_id = p.id and a.answered_at is not null
    left join public.questions qq on qq.id = a.question_id
    where p.quiz_id = v_quiz.id
    group by p.id, p.name
  ), ranked as (
    select *, rank() over (order by score desc) as rnk from scores
  )
  select jsonb_build_object(
    'score', coalesce((select score from ranked where id = p_player_id), 0),
    'rank', (select rnk from ranked where id = p_player_id),
    'correct', coalesce((select correct from ranked where id = p_player_id), 0),
    'leaderboard', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'score', score, 'rank', rnk, 'is_me', id = p_player_id)
                       order by rnk, name)
      from (select * from ranked order by rnk, name limit v_limit) t
    ), '[]'::jsonb)
  ) into v_lb;

  v_out := jsonb_build_object(
    'status', v_quiz.status,
    'quiz', jsonb_build_object('title', v_quiz.title, 'code', v_quiz.code,
                               'theme', v_quiz.theme, 'question_count', v_total),
    'name', v_player.name,
    'player_count', (select count(*) from public.players where quiz_id = v_quiz.id),
    'streak', v_streak
  ) || v_lb;

  if v_quiz.status = 'lobby' then
    v_out := v_out || jsonb_build_object('players', coalesce((
      select jsonb_agg(name order by created_at)
      from (select name, created_at from public.players
            where quiz_id = v_quiz.id order by created_at desc limit 60) t
    ), '[]'::jsonb));
  end if;

  if v_quiz.status in ('question', 'reveal') then
    select * into v_q from public.questions where quiz_id = v_quiz.id and pos = v_quiz.current_pos;
    select * into v_my from public.answers
      where player_id = p_player_id and question_id = v_q.id and answered_at is not null;
    v_closed := v_quiz.status = 'reveal' or now() >= v_quiz.question_ends_at;
    v_secs := case when v_closed then 0
                   else extract(epoch from (v_quiz.question_ends_at - now())) end;
    v_out := v_out || jsonb_build_object(
      'question', jsonb_build_object(
        'id', v_q.id, 'pos', v_q.pos, 'type', v_q.type, 'prompt', v_q.prompt,
        'image_url', v_q.image_url, 'options', v_q.options,
        'time_limit', v_q.time_limit, 'points', v_q.points,
        'max_answers', v_q.max_answers, 'max_chars', v_q.max_chars),
      'seconds_left', v_secs,
      'closed', v_closed,
      'answered', v_my.id is not null,
      'answered_count', (select count(*) from public.answers
                         where question_id = v_q.id and answered_at is not null)
    );

    -- Word-cloud style answers have no right answer, so they are safe to show once
    -- you have submitted yours (or after the reveal).
    if v_q.type = 'multi_answer' and (v_my.id is not null or v_quiz.status = 'reveal') then
      v_out := v_out || jsonb_build_object(
        'bubbles', public.quizbro_bubbles(v_q.id),
        'feed', public.quizbro_feed(v_q.id, p_player_id),
        'my_answers', v_my.answer,
        -- Seconds until this player may send their next answer.
        'cooldown_left', case when v_my.id is null then 0
                              else greatest(0, public.quizbro_answer_cooldown()
                                               - extract(epoch from (now() - v_my.answered_at))) end);
    end if;

    if v_quiz.status = 'reveal' then
      select * into v_k from public.question_keys where question_id = v_q.id;
      v_out := v_out || jsonb_build_object('reveal', jsonb_build_object(
        'correct', case when v_q.type in ('poll', 'multi_answer') then null else v_k.correct end,
        'is_correct', case when v_my.id is null
                           then (case when v_q.type in ('poll', 'multi_answer') then null else false end)
                           else v_my.is_correct end,
        'points', coalesce(v_my.points, 0),
        'answered', v_my.id is not null,
        'my_answer', v_my.answer
      ));
    end if;
  end if;

  if v_quiz.status = 'finished' then
    v_out := v_out || jsonb_build_object('review', coalesce((
      select jsonb_agg(jsonb_build_object(
               'pos', q.pos, 'prompt', q.prompt, 'type', q.type, 'options', q.options,
               'correct', case when q.type in ('poll', 'multi_answer') then null else k.correct end,
               'answer', a.answer,
               'is_correct', case when a.id is null and q.type not in ('poll', 'multi_answer') then false else a.is_correct end,
               'points', coalesce(a.points, 0)
             ) order by q.pos)
      from public.questions q
      join public.question_keys k on k.question_id = q.id
      left join public.answers a on a.question_id = q.id and a.player_id = p_player_id
                                and a.answered_at is not null
      where q.quiz_id = v_quiz.id
    ), '[]'::jsonb));
  end if;

  return v_out;
end $$;

create or replace function public.host_get_dashboard(p_quiz_id uuid, p_host_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_quiz public.quizzes;
  v_cur uuid;
begin
  v_quiz := public.quizbro_check_host(p_quiz_id, p_host_token);
  select id into v_cur from public.questions
  where quiz_id = v_quiz.id and pos = v_quiz.current_pos;

  return (
    with scores as (
      select p.id, p.name, p.created_at,
             coalesce(sum(a.points), 0)::int as score,
             count(*) filter (where a.answered_at is not null) as answered,
             count(*) filter (where a.is_correct) as correct,
             max(a.answered_at) as last_active
      from public.players p
      left join public.answers a on a.player_id = p.id and a.answered_at is not null
      where p.quiz_id = v_quiz.id
      group by p.id, p.name, p.created_at
    )
    select jsonb_build_object(
      'quiz', jsonb_build_object('id', v_quiz.id, 'code', v_quiz.code, 'title', v_quiz.title,
                                 'description', v_quiz.description, 'theme', v_quiz.theme),
      'state', jsonb_build_object(
        'status', v_quiz.status,
        'current_pos', v_quiz.current_pos,
        'seconds_left', case when v_quiz.status = 'question' and now() < v_quiz.question_ends_at
                             then extract(epoch from (v_quiz.question_ends_at - now())) else 0 end,
        'closed', v_quiz.status <> 'question' or now() >= v_quiz.question_ends_at
      ),
      'question_count', (select count(*) from public.questions where quiz_id = v_quiz.id),
      'players', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', id, 'name', name, 'score', score, 'answered', answered,
                 'correct', correct, 'last_active', last_active,
                 'answered_current', exists (
                   select 1 from public.answers a
                   where a.player_id = scores.id and a.question_id = v_cur and a.answered_at is not null)
               ) order by score desc, name)
        from scores
      ), '[]'::jsonb),
      'questions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', q.id, 'pos', q.pos, 'type', q.type, 'prompt', q.prompt,
                 'image_url', q.image_url,
                 'options', q.options, 'time_limit', q.time_limit, 'points', q.points,
                 'max_answers', q.max_answers, 'max_chars', q.max_chars,
                 'correct', k.correct,
                 'answered', (select count(*) from public.answers a
                              where a.question_id = q.id and a.answered_at is not null),
                 'right', (select count(*) from public.answers a
                           where a.question_id = q.id and a.is_correct),
                 'avg_time_ms', (select round(avg(a.time_ms))::int from public.answers a
                                 where a.question_id = q.id and a.answered_at is not null and a.answer is not null),
                 'counts', case when q.type in ('short_text', 'multi_answer') then null else (
                   select coalesce(jsonb_agg(c order by i), '[]'::jsonb)
                   from (
                     select i, (select count(*) from public.answers a
                                where a.question_id = q.id and a.answered_at is not null
                                  and a.answer @> to_jsonb(i)) as c
                     from generate_series(0, jsonb_array_length(q.options) - 1) i
                   ) s
                 ) end,
                 'texts', case when q.type = 'short_text' then (
                   select coalesce(jsonb_agg(jsonb_build_object('text', t, 'count', n, 'is_correct', ok)
                                             order by n desc, t), '[]'::jsonb)
                   from (
                     select lower(trim(a.answer #>> '{}')) as t, count(*) as n, bool_or(a.is_correct) as ok
                     from public.answers a
                     where a.question_id = q.id and a.answered_at is not null and a.answer is not null
                     group by 1
                     limit 30
                   ) s
                 ) else null end,
                 'bubbles', case when q.type = 'multi_answer' then public.quizbro_bubbles(q.id) else null end,
                 -- The live chat is only needed for the question on screen.
                 'feed', case when q.type = 'multi_answer' and q.id = v_cur then public.quizbro_feed(q.id, null) else null end
               ) order by q.pos)
        from public.questions q
        join public.question_keys k on k.question_id = q.id
        where q.quiz_id = v_quiz.id
      ), '[]'::jsonb)
    )
  );
end $$;

revoke all on function public.quizbro_feed(uuid, uuid, int) from public, anon, authenticated;
-- create or replace keeps the existing EXECUTE grants on the public RPCs above.
