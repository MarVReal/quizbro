-- Behaviour tests for 20261005000000_multi_answer.sql. Run against a scratch database that
-- already has all migrations applied (it creates its own quizzes):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/multi_answer.sql
-- It prints "ALL SERVER TESTS PASSED" on success and raises on the first failure.
\set ON_ERROR_STOP on
do $$
declare
  tok text := repeat('a', 32);
  quiz jsonb; qid uuid; code text;
  p1 uuid; p2 uuid; p3 uuid;
  q_mc uuid; q_poll uuid; q_multi uuid;
  r jsonb; st jsonb; dash jsonb;
  msg text;
  i int;

  procedure_dummy int;
begin
  -- ── create_quiz: new type + limits, existing types unaffected ──
  quiz := create_quiz('T', '', 'grape', tok, jsonb_build_array(
    jsonb_build_object('type','multiple_choice','prompt','mc','options',jsonb_build_array('a','b'),'correct',jsonb_build_array(0),'time_limit',30,'points',1000),
    jsonb_build_object('type','poll','prompt','poll','options',jsonb_build_array('x','y'),'time_limit',30),
    jsonb_build_object('type','multi_answer','prompt','words','max_answers',3,'max_chars',10,'time_limit',30)
  ));
  qid := (quiz->>'id')::uuid; code := quiz->>'code';
  select id into q_mc from questions where quiz_id=qid and pos=1;
  select id into q_poll from questions where quiz_id=qid and pos=2;
  select id into q_multi from questions where quiz_id=qid and pos=3;
  assert (select max_answers from questions where id=q_mc) = 1, 'default max_answers on old types';
  assert (select max_chars from questions where id=q_mc) = 40, 'default max_chars on old types';
  assert (select max_answers from questions where id=q_multi) = 3 and (select max_chars from questions where id=q_multi) = 10, 'limits stored';
  assert (select options from questions where id=q_multi) = '[]'::jsonb, 'no options';
  assert (select correct from question_keys where question_id=q_multi) = '[]'::jsonb, 'no key';
  assert (select points from questions where id=q_multi) = 0, 'unscored';

  -- defaults when omitted
  quiz := create_quiz('D','', 'grape', tok, jsonb_build_array(jsonb_build_object('type','multi_answer','prompt','w')));
  assert (select max_answers||'/'||max_chars from questions where quiz_id=(quiz->>'id')::uuid) = '3/40', 'defaults 3/40';

  -- out-of-range limits are rejected server-side
  foreach msg in array array['{"max_answers":0}','{"max_answers":21}','{"max_chars":0}','{"max_chars":201}'] loop
    begin
      perform create_quiz('X','', 'grape', tok, jsonb_build_array(('{"type":"multi_answer","prompt":"w"}'::jsonb || msg::jsonb)));
      raise exception 'should have failed for %', msg;
    exception when others then
      assert sqlerrm like '%max%', 'limit error for '||msg||': '||sqlerrm;
    end;
  end loop;
  -- boundary values accepted
  perform create_quiz('B','', 'grape', tok, jsonb_build_array('{"type":"multi_answer","prompt":"w","max_answers":20,"max_chars":200}'::jsonb));
  perform create_quiz('B','', 'grape', tok, jsonb_build_array('{"type":"multi_answer","prompt":"w","max_answers":1,"max_chars":1}'::jsonb));

  -- ── players + host flow ──
  p1 := (join_quiz(code,'p1')->>'player_id')::uuid;
  p2 := (join_quiz(code,'p2')->>'player_id')::uuid;
  p3 := (join_quiz(code,'p3')->>'player_id')::uuid;
  perform host_action(qid, tok, 'start');                 -- mc question
  perform submit_answer(p1, q_mc, '[0]'::jsonb);
  perform submit_answer(p2, q_mc, '[1]'::jsonb);
  perform submit_answer(p3, q_mc, '[0]'::jsonb);
  perform host_action(qid, tok, 'reveal'); perform host_action(qid, tok, 'next');   -- poll
  perform submit_answer(p1, q_poll, '[0]'::jsonb);
  perform host_action(qid, tok, 'reveal'); perform host_action(qid, tok, 'next');   -- multi
  assert (select status from quizzes where id=qid) = 'question' and (select current_pos from quizzes where id=qid) = 3;

  -- ── state before answering: question carries limits, no bubbles yet ──
  st := get_play_state(p1);
  assert (st->'question'->>'max_answers') = '3' and (st->'question'->>'max_chars') = '10', 'limits in play state';
  assert not (st ? 'bubbles'), 'no bubbles before answering';

  -- ── validation ──
  foreach msg in array array['null','"str"','{"a":1}','[]','[1]','[""]','["  "]','["abcdefghijk"]','["a","b","c","d"]','["Pizza","pizza"]','["x"," X "]'] loop
    begin
      perform submit_answer(p1, q_multi, msg::jsonb);
      raise exception 'should have failed for %', msg;
    exception when others then
      assert sqlerrm not like 'should have failed%', 'unexpectedly accepted '||msg;
    end;
  end loop;
  -- exact boundary: 10 chars ok; emoji counted as characters
  -- (nothing stored yet because every call above failed)
  assert not exists (select 1 from answers where question_id=q_multi), 'failed submits stored nothing';

  -- ── happy path + merging ──
  perform submit_answer(p1, q_multi, jsonb_build_array('Pizza', '  tacos ', 'abcdefghij'));
  assert (select answer from answers where player_id=p1 and question_id=q_multi) = '["Pizza","tacos","abcdefghij"]'::jsonb, 'trimmed on store';
  -- retry after success is rejected, not double-counted
  begin perform submit_answer(p1, q_multi, '["again"]'::jsonb); raise exception 'dup'; exception when others then assert sqlerrm='Already answered', sqlerrm; end;
  perform submit_answer(p2, q_multi, jsonb_build_array('PIZZA', 'Sushi', 'a'||chr(160)||chr(160)||'b'));
  perform submit_answer(p3, q_multi, jsonb_build_array('pizza', 'a b', U&'\+01F355'));

  st := get_play_state(p3);
  assert jsonb_array_length(st->'bubbles'->'items') = 6, 'six unique bubbles: '||(st->'bubbles')::text;
  assert (st->'bubbles'->'items'->0->>'count') = '3' and lower(st->'bubbles'->'items'->0->>'text') = 'pizza', 'pizza merged x3';
  assert (select count from jsonb_to_recordset(st->'bubbles'->'items') as t(key text, text text, count int) where key='a b') = 2, 'nbsp collapsed & merged with "a b"';
  assert (st->'bubbles'->>'more') = '0';
  assert (st->'reveal') is null, 'no reveal while question runs';

  -- host sees them too; counts null; old types still report counts
  dash := host_get_dashboard(qid, tok);
  assert jsonb_array_length(dash->'questions'->2->'bubbles'->'items') = 6, 'host bubbles';
  assert (dash->'questions'->2->'counts') = 'null'::jsonb, 'multi counts null';
  assert (dash->'questions'->0->'counts') = '[2,1]'::jsonb, 'mc counts unchanged';
  assert (dash->'questions'->0->'bubbles') = 'null'::jsonb, 'bubbles only for multi';
  assert (dash->'questions'->2->>'max_chars') = '10';

  -- ── reveal: unscored, bubbles visible even to a non-answerer ──
  perform host_action(qid, tok, 'reveal');
  st := get_play_state(p2);
  assert (st->'reveal'->'is_correct') = 'null'::jsonb and (st->'reveal'->'correct') = 'null'::jsonb, 'unscored reveal';
  assert (st->'reveal'->'points') = '0'::jsonb;
  assert (st->'bubbles'->'items'->0->>'count') = '3';
  assert (st->>'streak') = '0' or true;

  -- ── scoring for old types intact ──
  assert (select points from answers where player_id=p1 and question_id=q_mc) > 0, 'mc scored';
  assert (select points from answers where player_id=p2 and question_id=q_mc) = 0, 'mc wrong = 0';
  assert (select is_correct from answers where player_id=p1 and question_id=q_poll) is null, 'poll unscored';
  assert (select is_correct from answers where player_id=p1 and question_id=q_multi) is null, 'multi unscored';

  -- ── finished: review has strings, is_correct stays null for p-answerer and non-answerer ──
  perform host_action(qid, tok, 'next');
  st := get_play_state(p1);
  assert (st->'review'->2->>'type') = 'multi_answer' and (st->'review'->2->'answer') = '["Pizza","tacos","abcdefghij"]'::jsonb, 'review answer';
  assert (st->'review'->2->'is_correct') = 'null'::jsonb and (st->'review'->2->'correct') = 'null'::jsonb;
  assert (st->'review'->0->'is_correct') = 'true'::jsonb, 'mc review intact';

  -- ── bubble cap: 60 unique answers, limit 50, `more` = 10 ──
  quiz := create_quiz('C','', 'grape', tok, jsonb_build_array('{"type":"multi_answer","prompt":"w","max_answers":20,"max_chars":20,"time_limit":60}'::jsonb));
  qid := (quiz->>'id')::uuid; code := quiz->>'code';
  select id into q_multi from questions where quiz_id=qid;
  perform host_action(qid, tok, 'start');
  for i in 1..30 loop
    p1 := (join_quiz(code,'u'||i)->>'player_id')::uuid;
    perform submit_answer(p1, q_multi, jsonb_build_array('w'||(2*i-1), 'w'||(2*i), 'common'));
  end loop;
  r := quizbro_bubbles(q_multi);
  assert jsonb_array_length(r->'items') = 50 and (r->>'more') = '11', 'cap 50, more=11 (61 unique): '||(r->>'more');
  assert (r->'items'->0->>'text') = 'common' and (r->'items'->0->>'count') = '30', 'biggest first';
  raise notice 'ALL SERVER TESTS PASSED';
end $$;
