-- Multi-answer questions (word-cloud style, shown as live bubbles).
--
-- Additive: a new question type plus two per-question limits. Existing types and
-- rows are untouched. A submission is ONE answers row whose `answer` is a jsonb array
-- of strings, so it is all-or-nothing and the existing unique (player_id, question_id)
-- makes a retried submit harmless.
--
-- Like polls, multi_answer is unscored: no key, no points, is_correct stays null.

alter table public.questions drop constraint if exists questions_type_check;
alter table public.questions add constraint questions_type_check
  check (type in ('multiple_choice','multiple_select','true_false','short_text','poll','multi_answer'));

alter table public.questions
  add column if not exists max_answers int not null default 1 check (max_answers between 1 and 20),
  add column if not exists max_chars int not null default 40 check (max_chars between 1 and 200);

-- ───────────────────────── Helpers ─────────────────────────

-- The merge key for an answer: whitespace collapsed + trimmed + lower-cased. Two people
-- typing "Pizza", " pizza " and "PIZZA" land in the same bubble. Keep in sync with
-- normalizeAnswer() in src/lib/multi-answer.ts.
create or replace function public.quizbro_norm(p text) returns text
language sql immutable set search_path = public as $$
  select lower(btrim(regexp_replace(p, '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g')))
$$;

-- Validates and cleans a multi-answer submission, raising a readable error when it is
-- not acceptable. Lengths are counted in characters (code points), not bytes.
create or replace function public.quizbro_clean_answers(p jsonb, p_max_answers int, p_max_chars int)
returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  v_item jsonb;
  v_txt text;
  v_key text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    raise exception 'Invalid answer';
  end if;
  if jsonb_array_length(p) < 1 then
    raise exception 'Add at least one answer';
  end if;
  if jsonb_array_length(p) > p_max_answers then
    raise exception 'You can give up to % answer%', p_max_answers, case when p_max_answers = 1 then '' else 's' end;
  end if;
  for v_item in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v_item) <> 'string' then
      raise exception 'Invalid answer';
    end if;
    v_txt := btrim(regexp_replace(v_item #>> '{}', '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'));
    if char_length(v_txt) = 0 then
      raise exception 'Answers can''t be blank';
    end if;
    if char_length(v_txt) > p_max_chars then
      raise exception 'Keep each answer to % characters or fewer', p_max_chars;
    end if;
    v_key := public.quizbro_norm(v_txt);
    if v_key = any(v_seen) then
      raise exception 'You entered the same answer twice';
    end if;
    v_seen := v_seen || v_key;
    v_out := v_out || to_jsonb(v_txt);
  end loop;
  return v_out;
end $$;

-- Merged bubbles for a question: one entry per unique (normalised) answer with how many
-- people gave it, biggest first. Capped at p_limit; `more` is how many were left out.
create or replace function public.quizbro_bubbles(p_question_id uuid, p_limit int default 50)
returns jsonb
language sql stable security definer set search_path = public as $$
  with items as (
    select public.quizbro_norm(t.txt) as k, t.txt, a.answered_at
    from public.answers a
    cross join lateral jsonb_array_elements_text(a.answer) as t(txt)
    where a.question_id = p_question_id
      and a.answered_at is not null
      and jsonb_typeof(a.answer) = 'array'
  ), grouped as (
    select k as key,
           mode() within group (order by txt) as text,
           count(*)::int as count,
           max(answered_at) as last_at
    from items
    group by k
  ), top as (
    select * from grouped order by count desc, last_at desc, key limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('key', key, 'text', text, 'count', count)
                       order by count desc, last_at desc, key)
      from top
    ), '[]'::jsonb),
    'more', greatest(0, (select count(*) from grouped) - p_limit)
  )
$$;

-- ───────────────────────── Create a quiz ─────────────────────────

create or replace function public.create_quiz(
  p_title text,
  p_description text,
  p_theme text,
  p_host_token text,
  p_questions jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_quiz public.quizzes;
  q jsonb;
  v_pos int := 0;
  v_qid uuid;
  v_type text;
  v_opts jsonb;
  v_correct jsonb;
  v_n int;
  v_time int;
  v_points int;
  v_prompt text;
  v_maxa int;
  v_maxc int;
begin
  if p_title is null or length(trim(p_title)) not between 1 and 120 then
    raise exception 'Title must be 1-120 characters';
  end if;
  if p_host_token is null or length(p_host_token) < 24 then
    raise exception 'Invalid host token';
  end if;
  if p_questions is null or jsonb_typeof(p_questions) <> 'array'
     or jsonb_array_length(p_questions) not between 1 and 50 then
    raise exception 'A quiz needs 1-50 questions';
  end if;

  insert into public.quizzes (code, title, description, theme, host_token_hash)
  values (
    public.quizbro_gen_code(),
    trim(p_title),
    nullif(left(trim(coalesce(p_description, '')), 500), ''),
    case when p_theme in ('grape','sunset','ocean','mint','candy') then p_theme else 'grape' end,
    encode(sha256(convert_to(p_host_token, 'UTF8')), 'hex')
  )
  returning * into v_quiz;

  for q in select * from jsonb_array_elements(p_questions) loop
    v_pos := v_pos + 1;
    v_type := q->>'type';
    v_prompt := trim(coalesce(q->>'prompt', ''));
    v_opts := coalesce(q->'options', '[]'::jsonb);
    v_correct := coalesce(q->'correct', '[]'::jsonb);
    v_time := coalesce((q->>'time_limit')::int, 20);
    v_points := coalesce((q->>'points')::int, 1000);
    v_maxa := case when v_type = 'multi_answer' then coalesce((q->>'max_answers')::int, 3) else 1 end;
    v_maxc := case when v_type = 'multi_answer' then coalesce((q->>'max_chars')::int, 40) else 40 end;

    if length(v_prompt) not between 1 and 300 then
      raise exception 'Question %: prompt must be 1-300 characters', v_pos;
    end if;
    if v_time not between 5 and 120 then
      raise exception 'Question %: timer must be 5-120 seconds', v_pos;
    end if;
    if v_points not between 0 and 2000 then
      raise exception 'Question %: points must be 0-2000', v_pos;
    end if;
    if v_maxa not between 1 and 20 then
      raise exception 'Question %: max answers must be 1-20', v_pos;
    end if;
    if v_maxc not between 1 and 200 then
      raise exception 'Question %: max characters must be 1-200', v_pos;
    end if;

    if v_type = 'true_false' then
      v_opts := '["True","False"]'::jsonb;
    elsif v_type in ('short_text', 'multi_answer') then
      v_opts := '[]'::jsonb;
    elsif v_type in ('multiple_choice','multiple_select','poll') then
      if jsonb_typeof(v_opts) <> 'array' or jsonb_array_length(v_opts) not between 2 and 6 then
        raise exception 'Question %: needs 2-6 options', v_pos;
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_opts) o
        where jsonb_typeof(o) <> 'string' or length(trim(o #>> '{}')) not between 1 and 120
      ) then
        raise exception 'Question %: options must be 1-120 characters', v_pos;
      end if;
    else
      raise exception 'Question %: unknown type', v_pos;
    end if;
    v_n := jsonb_array_length(v_opts);

    if v_type in ('poll', 'multi_answer') then
      v_correct := '[]'::jsonb;
      v_points := 0;
    elsif v_type = 'short_text' then
      if jsonb_typeof(v_correct) <> 'array' or jsonb_array_length(v_correct) not between 1 and 10
         or exists (
           select 1 from jsonb_array_elements(v_correct) c
           where jsonb_typeof(c) <> 'string' or length(trim(c #>> '{}')) not between 1 and 200
         ) then
        raise exception 'Question %: give 1-10 accepted answers', v_pos;
      end if;
    else
      if jsonb_typeof(v_correct) <> 'array' or jsonb_array_length(v_correct) < 1
         or exists (
           select 1 from jsonb_array_elements(v_correct) c
           where jsonb_typeof(c) <> 'number' or (c #>> '{}')::numeric <> floor((c #>> '{}')::numeric)
              or (c #>> '{}')::int < 0 or (c #>> '{}')::int >= v_n
         ) then
        raise exception 'Question %: pick the correct answer', v_pos;
      end if;
      if v_type <> 'multiple_select' and jsonb_array_length(v_correct) <> 1 then
        raise exception 'Question %: exactly one correct answer', v_pos;
      end if;
    end if;

    insert into public.questions (quiz_id, pos, type, prompt, image_url, options, time_limit, points, max_answers, max_chars)
    values (
      v_quiz.id, v_pos, v_type, v_prompt,
      case when (q->>'image_url') ~ '^https?://' then left(q->>'image_url', 500) end,
      v_opts, v_time, v_points, v_maxa, v_maxc
    )
    returning id into v_qid;

    insert into public.question_keys (question_id, correct) values (v_qid, v_correct);
  end loop;

  return jsonb_build_object('id', v_quiz.id, 'code', v_quiz.code);
end $$;

-- ───────────────────────── Player state ─────────────────────────

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
      v_out := v_out || jsonb_build_object('bubbles', public.quizbro_bubbles(v_q.id));
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

-- ───────────────────────── Answering ─────────────────────────

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
  v_clean jsonb;
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

  if v_q.type = 'multi_answer' then
    v_clean := public.quizbro_clean_answers(p_answer, v_q.max_answers, v_q.max_chars);
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

  insert into public.answers (quiz_id, question_id, player_id, answer, is_correct, points, time_ms, answered_at)
  values (v_quiz.id, p_question_id, p_player_id,
          case when v_q.type = 'multi_answer' then v_clean else p_answer end, v_ok, v_pts,
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
                 'bubbles', case when q.type = 'multi_answer' then public.quizbro_bubbles(q.id) else null end
               ) order by q.pos)
        from public.questions q
        join public.question_keys k on k.question_id = q.id
        where q.quiz_id = v_quiz.id
      ), '[]'::jsonb)
    )
  );
end $$;

-- ───────────────────────── Grants ─────────────────────────

revoke all on function public.quizbro_norm(text) from public, anon, authenticated;
revoke all on function public.quizbro_clean_answers(jsonb, int, int) from public, anon, authenticated;
revoke all on function public.quizbro_bubbles(uuid, int) from public, anon, authenticated;
-- create or replace keeps the existing EXECUTE grants on the public RPCs below.
