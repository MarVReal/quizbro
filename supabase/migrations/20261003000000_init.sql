-- Quizbro schema.
--
-- Security model: every table has RLS enabled with NO policies and no grants for
-- anon/authenticated, so the browser can never read or write tables directly.
-- All access goes through the SECURITY DEFINER functions below, which keep the
-- correct answers server-side and verify the host token / player id.

-- ───────────────────────── Tables ─────────────────────────

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  description text,
  theme text not null default 'grape',
  host_token_hash text not null,
  created_at timestamptz not null default now()
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  pos int not null,
  type text not null check (type in ('multiple_choice','multiple_select','true_false','short_text','poll')),
  prompt text not null,
  image_url text,
  options jsonb not null default '[]'::jsonb,
  time_limit int not null default 20 check (time_limit between 5 and 120),
  points int not null default 1000 check (points between 0 and 2000),
  unique (quiz_id, pos)
);

-- Correct answers live in their own table so they can never leak via question reads.
create table public.question_keys (
  question_id uuid primary key references public.questions(id) on delete cascade,
  correct jsonb not null default '[]'::jsonb
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (quiz_id, name)
);

create table public.answers (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  answer jsonb,
  is_correct boolean,
  points int not null default 0,
  time_ms int,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  unique (player_id, question_id)
);

create index answers_quiz_idx on public.answers (quiz_id);
create index players_quiz_idx on public.players (quiz_id);
create index questions_quiz_idx on public.questions (quiz_id, pos);

alter table public.quizzes enable row level security;
alter table public.questions enable row level security;
alter table public.question_keys enable row level security;
alter table public.players enable row level security;
alter table public.answers enable row level security;

revoke all on public.quizzes, public.questions, public.question_keys, public.players, public.answers
  from anon, authenticated;

-- ───────────────────────── Helpers ─────────────────────────

create or replace function public.quizbro_gen_code() returns text
language plpgsql set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c text;
  i int;
begin
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.quizzes where code = c);
  end loop;
  return c;
end $$;

-- Normalises a jsonb array of integers to a sorted int[] for set comparison.
create or replace function public.quizbro_int_set(p jsonb) returns int[]
language sql immutable set search_path = public as $$
  select coalesce(array_agg(distinct x::int order by x::int), '{}'::int[])
  from jsonb_array_elements_text(p) x
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

    if length(v_prompt) not between 1 and 300 then
      raise exception 'Question %: prompt must be 1-300 characters', v_pos;
    end if;
    if v_time not between 5 and 120 then
      raise exception 'Question %: timer must be 5-120 seconds', v_pos;
    end if;
    if v_points not between 0 and 2000 then
      raise exception 'Question %: points must be 0-2000', v_pos;
    end if;

    if v_type = 'true_false' then
      v_opts := '["True","False"]'::jsonb;
    elsif v_type = 'short_text' then
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

    if v_type = 'poll' then
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

    insert into public.questions (quiz_id, pos, type, prompt, image_url, options, time_limit, points)
    values (
      v_quiz.id, v_pos, v_type, v_prompt,
      case when (q->>'image_url') ~ '^https?://' then left(q->>'image_url', 500) end,
      v_opts, v_time, v_points
    )
    returning id into v_qid;

    insert into public.question_keys (question_id, correct) values (v_qid, v_correct);
  end loop;

  return jsonb_build_object('id', v_quiz.id, 'code', v_quiz.code);
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

-- Returns the player's current question (starting its server-side timer on first
-- fetch, so a refresh cannot reset the clock) or {done: true}.
create or replace function public.next_question(p_player_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_player public.players;
  v_q public.questions;
  v_a public.answers;
  v_total int;
  v_secs numeric;
  v_score int;
  v_has_key boolean;
begin
  select * into v_player from public.players where id = p_player_id;
  if not found then raise exception 'Player not found'; end if;
  select count(*) into v_total from public.questions where quiz_id = v_player.quiz_id;

  loop
    select coalesce(sum(points), 0) into v_score from public.answers where player_id = p_player_id;

    select q.* into v_q
    from public.questions q
    where q.quiz_id = v_player.quiz_id
      and not exists (
        select 1 from public.answers a
        where a.player_id = p_player_id and a.question_id = q.id and a.answered_at is not null
      )
    order by q.pos
    limit 1;

    if not found then
      return jsonb_build_object('done', true, 'total', v_total, 'score', v_score);
    end if;

    insert into public.answers (quiz_id, question_id, player_id)
    values (v_player.quiz_id, v_q.id, p_player_id)
    on conflict (player_id, question_id) do nothing;

    select * into v_a from public.answers where player_id = p_player_id and question_id = v_q.id;
    v_secs := v_q.time_limit - extract(epoch from (now() - v_a.started_at));

    if v_secs < -2 then
      -- Player walked away past the deadline: record a timeout and move on.
      select jsonb_array_length(correct) > 0 into v_has_key from public.question_keys where question_id = v_q.id;
      update public.answers
      set answered_at = now(), points = 0, time_ms = v_q.time_limit * 1000,
          is_correct = case when v_has_key then false else null end
      where id = v_a.id;
      continue;
    end if;

    return jsonb_build_object(
      'done', false,
      'total', v_total,
      'score', v_score,
      'seconds_left', greatest(v_secs, 0),
      'question', jsonb_build_object(
        'id', v_q.id,
        'pos', v_q.pos,
        'type', v_q.type,
        'prompt', v_q.prompt,
        'image_url', v_q.image_url,
        'options', v_q.options,
        'time_limit', v_q.time_limit,
        'points', v_q.points
      )
    );
  end loop;
end $$;

create or replace function public.submit_answer(p_player_id uuid, p_question_id uuid, p_answer jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a public.answers;
  v_q public.questions;
  v_k public.question_keys;
  v_elapsed numeric;
  v_ok boolean;
  v_pts int := 0;
  v_timed_out boolean := false;
  v_n int;
  v_stored jsonb := p_answer;
begin
  select * into v_a from public.answers
  where player_id = p_player_id and question_id = p_question_id for update;
  if not found then raise exception 'Question was not started'; end if;
  if v_a.answered_at is not null then raise exception 'Already answered'; end if;

  select * into v_q from public.questions where id = p_question_id;
  select * into v_k from public.question_keys where question_id = p_question_id;
  v_elapsed := extract(epoch from (now() - v_a.started_at));
  v_n := jsonb_array_length(v_q.options);

  if v_elapsed > v_q.time_limit + 2 then
    v_timed_out := true;
    v_stored := null;
    v_ok := case when v_q.type = 'poll' then null else false end;
  else
    if v_q.type = 'short_text' then
      if p_answer is null or jsonb_typeof(p_answer) <> 'string' or length(p_answer #>> '{}') > 200 then
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

    if v_ok then
      -- Faster answers earn more: full points instantly, half points at the buzzer.
      v_pts := round(v_q.points * (1 - 0.5 * least(1, greatest(0, v_elapsed / v_q.time_limit))));
    end if;
  end if;

  update public.answers
  set answer = v_stored,
      is_correct = v_ok,
      points = v_pts,
      time_ms = least(round(v_elapsed * 1000), v_q.time_limit * 1000 + 2000)::int,
      answered_at = now()
  where id = v_a.id;

  return jsonb_build_object(
    'is_correct', v_ok,
    'points', v_pts,
    'timed_out', v_timed_out,
    'correct', case when v_q.type = 'poll' then null else v_k.correct end
  );
end $$;

create or replace function public.get_results(p_player_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_player public.players;
  v_quiz public.quizzes;
begin
  select * into v_player from public.players where id = p_player_id;
  if not found then raise exception 'Player not found'; end if;
  select * into v_quiz from public.quizzes where id = v_player.quiz_id;

  return (
    with scores as (
      select p.id, p.name, coalesce(sum(a.points), 0)::int as score,
             count(*) filter (where a.is_correct) as correct
      from public.players p
      left join public.answers a on a.player_id = p.id and a.answered_at is not null
      where p.quiz_id = v_quiz.id
      group by p.id, p.name
    ), ranked as (
      select *, rank() over (order by score desc) as rnk from scores
    )
    select jsonb_build_object(
      'quiz', jsonb_build_object('title', v_quiz.title, 'code', v_quiz.code, 'theme', v_quiz.theme),
      'name', v_player.name,
      'score', (select score from ranked where id = p_player_id),
      'rank', (select rnk from ranked where id = p_player_id),
      'correct', (select correct from ranked where id = p_player_id),
      'player_count', (select count(*) from ranked),
      'leaderboard', coalesce((
        select jsonb_agg(jsonb_build_object('name', name, 'score', score, 'rank', rnk, 'is_me', id = p_player_id)
                         order by rnk, name)
        from (select * from ranked order by rnk, name limit 10) top
      ), '[]'::jsonb),
      'review', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'pos', q.pos, 'prompt', q.prompt, 'type', q.type, 'options', q.options,
                 'correct', case when q.type = 'poll' then null else k.correct end,
                 'answer', a.answer, 'is_correct', a.is_correct, 'points', a.points
               ) order by q.pos)
        from public.answers a
        join public.questions q on q.id = a.question_id
        join public.question_keys k on k.question_id = q.id
        where a.player_id = p_player_id and a.answered_at is not null
      ), '[]'::jsonb)
    )
  );
end $$;

-- ───────────────────────── Host ─────────────────────────

create or replace function public.host_get_dashboard(p_quiz_id uuid, p_host_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_quiz public.quizzes;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found
     or v_quiz.host_token_hash <> encode(sha256(convert_to(coalesce(p_host_token, ''), 'UTF8')), 'hex') then
    raise exception 'Invalid host link';
  end if;

  return (
    with scores as (
      select p.id, p.name, p.created_at,
             coalesce(sum(a.points), 0)::int as score,
             count(*) filter (where a.answered_at is not null) as answered,
             count(*) filter (where a.is_correct) as correct,
             max(a.answered_at) as last_active
      from public.players p
      left join public.answers a on a.player_id = p.id
      where p.quiz_id = v_quiz.id
      group by p.id, p.name, p.created_at
    )
    select jsonb_build_object(
      'quiz', jsonb_build_object('id', v_quiz.id, 'code', v_quiz.code, 'title', v_quiz.title,
                                 'description', v_quiz.description, 'theme', v_quiz.theme),
      'question_count', (select count(*) from public.questions where quiz_id = v_quiz.id),
      'players', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', id, 'name', name, 'score', score, 'answered', answered,
                 'correct', correct, 'last_active', last_active
               ) order by score desc, name)
        from scores
      ), '[]'::jsonb),
      'questions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', q.id, 'pos', q.pos, 'type', q.type, 'prompt', q.prompt,
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

revoke all on function public.quizbro_gen_code() from public, anon, authenticated;
revoke all on function public.quizbro_int_set(jsonb) from public, anon, authenticated;

revoke all on function public.create_quiz(text, text, text, text, jsonb) from public;
revoke all on function public.get_quiz_public(text) from public;
revoke all on function public.join_quiz(text, text) from public;
revoke all on function public.next_question(uuid) from public;
revoke all on function public.submit_answer(uuid, uuid, jsonb) from public;
revoke all on function public.get_results(uuid) from public;
revoke all on function public.host_get_dashboard(uuid, text) from public;

grant execute on function public.create_quiz(text, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.get_quiz_public(text) to anon, authenticated;
grant execute on function public.join_quiz(text, text) to anon, authenticated;
grant execute on function public.next_question(uuid) to anon, authenticated;
grant execute on function public.submit_answer(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.get_results(uuid) to anon, authenticated;
grant execute on function public.host_get_dashboard(uuid, text) to anon, authenticated;
