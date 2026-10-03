-- Let the client report "my timer hit zero" by submitting a null answer near the
-- deadline. The server still decides: a null answer is only accepted as a timeout
-- once (almost) the full time limit has really elapsed.

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

  if v_elapsed > v_q.time_limit + 2
     or (p_answer is null and v_elapsed >= v_q.time_limit - 1) then
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

revoke all on function public.submit_answer(uuid, uuid, jsonb) from public;
grant execute on function public.submit_answer(uuid, uuid, jsonb) to anon, authenticated;
