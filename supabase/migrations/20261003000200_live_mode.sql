-- Live (host-paced) mode.
--
-- The host now drives the game: lobby -> question -> reveal -> ... -> finished.
-- All state lives on the quiz row; players and the host poll for it. Correct
-- answers are only sent to phones once the host has tapped "reveal".

alter table public.quizzes
  add column status text not null default 'lobby'
    check (status in ('lobby', 'question', 'reveal', 'finished')),
  add column current_pos int not null default 0,
  add column question_started_at timestamptz,
  add column question_ends_at timestamptz;

-- Replaced by get_play_state (players no longer pull their own next question).
-- If you cannot run DROP, revoking EXECUTE from anon/authenticated is equivalent.
drop function if exists public.next_question(uuid);
drop function if exists public.get_results(uuid);

-- ───────────────────────── Internal helpers ─────────────────────────

create or replace function public.quizbro_check_host(
  p_quiz_id uuid, p_token text, p_lock boolean default false
) returns public.quizzes
language plpgsql security definer set search_path = public as $$
declare v public.quizzes;
begin
  if p_lock then
    select * into v from public.quizzes where id = p_quiz_id for update;
  else
    select * into v from public.quizzes where id = p_quiz_id;
  end if;
  if not found
     or v.host_token_hash <> encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') then
    raise exception 'Invalid host link';
  end if;
  return v;
end $$;

-- Highest question position whose points are visible to players right now.
create or replace function public.quizbro_upto(v public.quizzes) returns int
language sql immutable set search_path = public as $$
  select case v.status
    when 'lobby' then 0
    when 'question' then v.current_pos - 1
    else v.current_pos
  end
$$;

create or replace function public.quizbro_open_question(p_quiz_id uuid, p_pos int) returns void
language plpgsql security definer set search_path = public as $$
declare v_limit int;
begin
  select time_limit into v_limit from public.questions where quiz_id = p_quiz_id and pos = p_pos;
  update public.quizzes
  set status = 'question',
      current_pos = p_pos,
      question_started_at = now(),
      question_ends_at = now() + make_interval(secs => v_limit)
  where id = p_quiz_id;
end $$;

-- ───────────────────────── Host controls ─────────────────────────

create or replace function public.host_action(p_quiz_id uuid, p_host_token text, p_action text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.quizzes;
  v_total int;
begin
  v := public.quizbro_check_host(p_quiz_id, p_host_token, true);
  select count(*) into v_total from public.questions where quiz_id = v.id;

  if p_action = 'start' then
    if v.status <> 'lobby' then raise exception 'The game has already started'; end if;
    perform public.quizbro_open_question(v.id, 1);

  elsif p_action = 'close' then
    -- End the timer early; answers are still hidden until "reveal".
    if v.status <> 'question' then raise exception 'No question is running'; end if;
    update public.quizzes set question_ends_at = least(question_ends_at, now()) where id = v.id;

  elsif p_action = 'reveal' then
    if v.status = 'reveal' then
      return jsonb_build_object('ok', true);
    end if;
    if v.status <> 'question' then raise exception 'Nothing to reveal'; end if;
    update public.quizzes
    set status = 'reveal', question_ends_at = least(question_ends_at, now())
    where id = v.id;

  elsif p_action = 'next' then
    if v.status <> 'reveal' then raise exception 'Reveal the answer first'; end if;
    if v.current_pos >= v_total then
      update public.quizzes set status = 'finished' where id = v.id;
    else
      perform public.quizbro_open_question(v.id, v.current_pos + 1);
    end if;

  elsif p_action = 'reset' then
    -- Play again with the same quiz: everyone is removed and must rejoin.
    delete from public.players where quiz_id = v.id;
    update public.quizzes
    set status = 'lobby', current_pos = 0, question_started_at = null, question_ends_at = null
    where id = v.id;

  else
    raise exception 'Unknown action';
  end if;

  return jsonb_build_object('ok', true);
end $$;

-- ───────────────────────── Players ─────────────────────────

create or replace function public.get_quiz_public(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_quiz public.quizzes;
begin
  select * into v_quiz from public.quizzes where code = upper(trim(p_code));
  if not found then raise exception 'Quiz not found'; end if;
  return jsonb_build_object(
    'id', v_quiz.id,
    'code', v_quiz.code,
    'title', v_quiz.title,
    'description', v_quiz.description,
    'theme', v_quiz.theme,
    'status', v_quiz.status,
    'question_count', (select count(*) from public.questions where quiz_id = v_quiz.id)
  );
end $$;

create or replace function public.join_quiz(p_code text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_quiz public.quizzes;
  v_name text := trim(coalesce(p_name, ''));
  v_player public.players;
begin
  if length(v_name) not between 1 and 24 then
    raise exception 'Name must be 1-24 characters';
  end if;
  select * into v_quiz from public.quizzes where code = upper(trim(p_code));
  if not found then raise exception 'Quiz not found'; end if;
  if v_quiz.status = 'finished' then raise exception 'This game has ended'; end if;
  if (select count(*) from public.players where quiz_id = v_quiz.id) >= 500 then
    raise exception 'This quiz is full';
  end if;
  begin
    insert into public.players (quiz_id, name) values (v_quiz.id, v_name) returning * into v_player;
  exception when unique_violation then
    raise exception 'That name is taken, pick another one';
  end;
  return jsonb_build_object('player_id', v_player.id, 'quiz_id', v_quiz.id, 'name', v_player.name);
end $$;

-- Everything a phone needs for the current moment of the game.
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
    if r.type = 'poll' then continue; end if;
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
        'time_limit', v_q.time_limit, 'points', v_q.points),
      'seconds_left', v_secs,
      'closed', v_closed,
      'answered', v_my.id is not null,
      'answered_count', (select count(*) from public.answers
                         where question_id = v_q.id and answered_at is not null)
    );

    if v_quiz.status = 'reveal' then
      select * into v_k from public.question_keys where question_id = v_q.id;
      v_out := v_out || jsonb_build_object('reveal', jsonb_build_object(
        'correct', case when v_q.type = 'poll' then null else v_k.correct end,
        'is_correct', case when v_my.id is null
                           then (case when v_q.type = 'poll' then null else false end)
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
               'correct', case when q.type = 'poll' then null else k.correct end,
               'answer', a.answer,
               'is_correct', case when a.id is null and q.type <> 'poll' then false else a.is_correct end,
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

-- Locks in an answer for the current question. The result is deliberately NOT
-- returned: players learn whether they were right when the host reveals it.
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
  if exists (select 1 from public.answers where player_id = p_player_id and question_id = p_question_id) then
    raise exception 'Already answered';
  end if;

  select * into v_k from public.question_keys where question_id = p_question_id;
  v_n := jsonb_array_length(v_q.options);

  if v_q.type = 'short_text' then
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

  insert into public.answers (quiz_id, question_id, player_id, answer, is_correct, points, time_ms, answered_at)
  values (v_quiz.id, p_question_id, p_player_id, p_answer, v_ok, v_pts,
          least(round(v_elapsed * 1000), v_q.time_limit * 1000 + 1000)::int, now());

  -- Everyone has answered: close the question early.
  if now() < v_quiz.question_ends_at
     and (select count(*) from public.answers
          where question_id = p_question_id and answered_at is not null)
         >= (select count(*) from public.players where quiz_id = v_quiz.id) then
    update public.quizzes set question_ends_at = now() where id = v_quiz.id;
  end if;

  return jsonb_build_object('accepted', true);
end $$;

-- ───────────────────────── Host dashboard ─────────────────────────

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
                 'correct', k.correct,
                 'answered', (select count(*) from public.answers a
                              where a.question_id = q.id and a.answered_at is not null),
                 'right', (select count(*) from public.answers a
                           where a.question_id = q.id and a.is_correct),
                 'avg_time_ms', (select round(avg(a.time_ms))::int from public.answers a
                                 where a.question_id = q.id and a.answered_at is not null and a.answer is not null),
                 'counts', case when q.type = 'short_text' then null else (
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
                 ) else null end
               ) order by q.pos)
        from public.questions q
        join public.question_keys k on k.question_id = q.id
        where q.quiz_id = v_quiz.id
      ), '[]'::jsonb)
    )
  );
end $$;

-- ───────────────────────── Grants ─────────────────────────

revoke all on function public.quizbro_check_host(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.quizbro_upto(public.quizzes) from public, anon, authenticated;
revoke all on function public.quizbro_open_question(uuid, int) from public, anon, authenticated;

revoke all on function public.host_action(uuid, text, text) from public;
revoke all on function public.get_play_state(uuid) from public;
revoke all on function public.get_quiz_public(text) from public;
revoke all on function public.join_quiz(text, text) from public;
revoke all on function public.submit_answer(uuid, uuid, jsonb) from public;
revoke all on function public.host_get_dashboard(uuid, text) from public;

grant execute on function public.host_action(uuid, text, text) to anon, authenticated;
grant execute on function public.get_play_state(uuid) to anon, authenticated;
grant execute on function public.get_quiz_public(text) to anon, authenticated;
grant execute on function public.join_quiz(text, text) to anon, authenticated;
grant execute on function public.submit_answer(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.host_get_dashboard(uuid, text) to anon, authenticated;
