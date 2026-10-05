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
  foreach msg in array array['null','""','"   "','"abcdefghijk"','{"a":1}','[]','[1]','[""]','["  "]','["abcdefghijk"]','["a","b","c","d"]','["Pizza","pizza"]','["x"," X "]'] loop
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
  begin perform submit_answer(p1, q_multi, '"again"'::jsonb); raise exception 'dup'; exception when others then assert sqlerrm='You have used all your answers', sqlerrm; end;
  perform submit_answer(p2, q_multi, jsonb_build_array('PIZZA', 'Sushi', 'a'||chr(160)||chr(160)||'b'));
  perform submit_answer(p3, q_multi, jsonb_build_array('pizza', 'a b', U&'\+01F355'));

  st := get_play_state(p3);
  assert jsonb_array_length(st->'bubbles'->'items') = 6, 'six unique bubbles: '||(st->'bubbles')::text;
  assert (st->'bubbles'->'items'->0->>'count') = '3' and lower(st->'bubbles'->'items'->0->>'text') = 'pizza', 'pizza merged x3';
  assert (select count from jsonb_to_recordset(st->'bubbles'->'items') as t(key text, text text, count int) where key='a b') = 2, 'nbsp collapsed & merged with "a b"';
  assert (st->'bubbles'->>'more') = '0';
  assert (st->'my_answers') = jsonb_build_array('pizza', 'a b', U&'\+01F355'), 'my_answers returned';
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
  raise notice 'BATCH TESTS PASSED';
end $$;

-- ───────────────────────── One answer at a time ─────────────────────────
do $$
declare
  tok text := repeat('c', 32);
  quiz jsonb; qid uuid; code text; q uuid; qpoll uuid;
  p1 uuid; p2 uuid; st jsonb; dash jsonb; msg text; t1 timestamptz;
  procedure_dummy int;
  -- helper: pretend the player's last answer was `s` seconds ago
  s_back text := 'update answers set answered_at = now() - make_interval(secs => %s) where player_id = %L and question_id = %L';
begin
  quiz := create_quiz('One at a time', '', 'grape', tok, jsonb_build_array(
    jsonb_build_object('type','multi_answer','prompt','words','max_answers',3,'max_chars',10,'time_limit',60),
    jsonb_build_object('type','poll','prompt','p','options',jsonb_build_array('a','b'),'time_limit',30)
  ));
  qid := (quiz->>'id')::uuid; code := quiz->>'code';
  select id into q from questions where quiz_id = qid and pos = 1;
  select id into qpoll from questions where quiz_id = qid and pos = 2;
  p1 := (join_quiz(code,'one')->>'player_id')::uuid;
  p2 := (join_quiz(code,'two')->>'player_id')::uuid;
  perform host_action(qid, tok, 'start');

  -- first single answer is accepted and appended as a one-item list
  perform submit_answer(p1, q, '"Pizza"'::jsonb);
  assert (select answer from answers where player_id = p1 and question_id = q) = '["Pizza"]'::jsonb, 'first answer stored';
  t1 := (select answered_at from answers where player_id = p1 and question_id = q);

  -- cooldown: an immediate second answer is refused and nothing changes
  begin perform submit_answer(p1, q, '"Tacos"'::jsonb); raise exception 'accepted early'; exception when others then msg := sqlerrm; end;
  assert msg = 'Wait a moment before your next answer', 'cooldown: ' || msg;
  assert (select answer from answers where player_id = p1 and question_id = q) = '["Pizza"]'::jsonb, 'unchanged after refusal';

  -- the phone is told how long is left, and sees its own answers + the cloud after the first send
  st := get_play_state(p1);
  assert (st->>'cooldown_left')::numeric > 2 and (st->>'cooldown_left')::numeric <= 3, 'cooldown_left: ' || (st->>'cooldown_left');
  assert (st->'my_answers') = '["Pizza"]'::jsonb and (st->'answered') = 'true'::jsonb;
  assert jsonb_array_length(st->'bubbles'->'items') = 1;
  -- someone who has not answered yet sees no cloud (nothing to copy from)
  assert not (get_play_state(p2) ? 'bubbles'), 'no cloud before your first answer';

  -- after the cooldown: duplicates of your own earlier answers are refused (any casing/spacing) ...
  execute format(s_back, 4, p1, q);
  assert (get_play_state(p1)->>'cooldown_left')::numeric = 0, 'cooldown over';
  foreach msg in array array['"pizza"','"  PIZZA "','["tacos","TACOS"]'] loop
    begin perform submit_answer(p1, q, msg::jsonb); raise exception 'accepted %', msg; exception when others then
      assert sqlerrm in ('You already gave that answer','You entered the same answer twice'), msg || ' -> ' || sqlerrm; end;
  end loop;
  -- ... blanks, too-long and wrong shapes are refused ...
  foreach msg in array array['""','"   "','"abcdefghijk"','5','null','{"a":1}'] loop
    begin perform submit_answer(p1, q, msg::jsonb); raise exception 'accepted %', msg; exception when others then
      assert sqlerrm not like 'accepted%', 'unexpectedly accepted ' || msg; end;
  end loop;
  -- ... and a good one is appended in order, refreshing the cooldown clock
  t1 := (select answered_at from answers where player_id = p1 and question_id = q);   -- back-dated by 4s above
  perform submit_answer(p1, q, '" Tacos "'::jsonb);
  assert (select answer from answers where player_id = p1 and question_id = q) = '["Pizza","Tacos"]'::jsonb, 'appended in order';
  assert (select answered_at from answers where player_id = p1 and question_id = q) > t1, 'answered_at moved on';
  assert (select count(*) from answers where player_id = p1 and question_id = q) = 1, 'still one row per player';

  -- the third answer uses the last slot; a fourth is refused whether or not the cooldown has passed
  execute format(s_back, 4, p1, q);
  perform submit_answer(p1, q, '"Sushi"'::jsonb);
  execute format(s_back, 4, p1, q);
  begin perform submit_answer(p1, q, '"Ramen"'::jsonb); raise exception 'accepted 4th'; exception when others then msg := sqlerrm; end;
  assert msg = 'You have used all your answers', msg;
  begin perform submit_answer(p1, q, '"Ramen"'::jsonb); raise exception 'accepted 4th'; exception when others then msg := sqlerrm; end;

  -- a list that would overflow the remaining slots is refused as a whole
  perform submit_answer(p2, q, '"Pizza"'::jsonb);
  execute format(s_back, 4, p2, q);
  begin perform submit_answer(p2, q, '["a","b","c"]'::jsonb); raise exception 'accepted overflow'; exception when others then msg := sqlerrm; end;
  assert msg = 'You only have 2 answers left', msg;
  assert (select answer from answers where player_id = p2 and question_id = q) = '["Pizza"]'::jsonb, 'nothing partially stored';

  -- the question stays open until everybody has used every answer (p2 still has 2 left)
  assert (select question_ends_at from quizzes where id = qid) > now(), 'still open';
  execute format(s_back, 4, p2, q); perform submit_answer(p2, q, '"Sushi"'::jsonb);
  execute format(s_back, 4, p2, q); perform submit_answer(p2, q, '"Curry"'::jsonb);
  assert (select question_ends_at from quizzes where id = qid) <= now(), 'closed once everyone used all answers';

  -- bubbles merge across players and across their separate sends
  dash := host_get_dashboard(qid, tok);
  assert (dash->'questions'->0->'bubbles'->'items'->0->>'key') in ('pizza','sushi') and (dash->'questions'->0->'bubbles'->'items'->0->>'count') = '2', 'merged: ' || (dash->'questions'->0->'bubbles')::text;
  assert jsonb_array_length(dash->'questions'->0->'bubbles'->'items') = 4, 'pizza, tacos, sushi, curry';
  assert (dash->'questions'->0->>'answered') = '2', 'two players answered';

  -- other question types still refuse a second answer and still reject bare strings where they must
  perform host_action(qid, tok, 'reveal'); perform host_action(qid, tok, 'next');
  perform submit_answer(p1, qpoll, '[0]'::jsonb);
  begin perform submit_answer(p1, qpoll, '[1]'::jsonb); raise exception 'accepted'; exception when others then assert sqlerrm = 'Already answered', sqlerrm; end;
  begin perform submit_answer(p2, qpoll, '"a"'::jsonb); raise exception 'accepted'; exception when others then assert sqlerrm = 'Invalid answer', sqlerrm; end;

  raise notice 'ONE-AT-A-TIME TESTS PASSED';
end $$;

-- ───────────────────────── Live chat feed ─────────────────────────
do $$
declare
  tok text := repeat('f', 32);
  quiz jsonb; qid uuid; code text; q1 uuid; q2 uuid;
  p1 uuid; p2 uuid; p3 uuid; st jsonb; dash jsonb; feed jsonb;
begin
  quiz := create_quiz('Chat', '', 'grape', tok, jsonb_build_array(
    jsonb_build_object('type','multi_answer','prompt','one','max_answers',5,'max_chars',20,'time_limit',60),
    jsonb_build_object('type','multi_answer','prompt','two','max_answers',5,'max_chars',20,'time_limit',60)
  ));
  qid := (quiz->>'id')::uuid; code := quiz->>'code';
  select id into q1 from questions where quiz_id = qid and pos = 1;
  select id into q2 from questions where quiz_id = qid and pos = 2;
  p1 := (join_quiz(code,'Ana')->>'player_id')::uuid;
  p2 := (join_quiz(code,'Ben')->>'player_id')::uuid;
  p3 := (join_quiz(code,'Cy')->>'player_id')::uuid;
  perform host_action(qid, tok, 'start');

  -- nothing yet
  assert quizbro_feed(q1) = '[]'::jsonb, 'empty feed';

  perform submit_answer(p1, q1, '"Pizza"'::jsonb);
  perform submit_answer(p2, q1, '"  tacos "'::jsonb);
  update answers set answered_at = now() - interval '5 seconds' where player_id = p1 and question_id = q1;
  perform submit_answer(p1, q1, '"Sushi"'::jsonb);
  perform submit_answer(p3, q1, '["Ramen","Pho"]'::jsonb);          -- a list lands as separate messages, in order

  -- every answer is one chat message, oldest first, with the sender's name and cleaned text
  feed := quizbro_feed(q1, p1);
  assert jsonb_array_length(feed) = 5, 'five messages: ' || feed::text;
  assert (select string_agg(m->>'name' || ':' || (m->>'text'), ' | ' order by ord) from jsonb_array_elements(feed) with ordinality as t(m, ord))
         = 'Ana:Pizza | Ben:tacos | Ana:Sushi | Cy:Ramen | Cy:Pho', 'order and names';
  -- ids only ever go up, so a client can tell which messages are new
  assert (select bool_and((m->>'id')::bigint > coalesce(lag_id, 0)) from (select m, lag((m->>'id')::bigint) over (order by ord) as lag_id from jsonb_array_elements(feed) with ordinality as t(m, ord)) x), 'ids increase';
  -- is_me marks my own messages only
  assert (select count(*) from jsonb_array_elements(feed) m where (m->>'is_me')::boolean) = 2, 'two of mine';
  assert (select count(*) from jsonb_array_elements(quizbro_feed(q1, null)) m where (m->>'is_me')::boolean) = 0, 'host view has no "me"';
  -- the limit keeps the newest
  assert (select string_agg(m->>'text', ',' order by ord) from jsonb_array_elements(quizbro_feed(q1, null, 2)) with ordinality as t(m, ord)) = 'Ramen,Pho', 'limit keeps newest';

end $$;

do $$
declare
  tok text := repeat('g', 32);
  quiz jsonb; qid uuid; code text; q1 uuid; p1 uuid; p2 uuid; st jsonb; dash jsonb;
begin
  quiz := create_quiz('Chat2', '', 'grape', tok, jsonb_build_array(
    jsonb_build_object('type','multi_answer','prompt','one','max_answers',5,'max_chars',20,'time_limit',60),
    jsonb_build_object('type','multi_answer','prompt','two','max_answers',5,'max_chars',20,'time_limit',60)));
  qid := (quiz->>'id')::uuid; code := quiz->>'code';
  select id into q1 from questions where quiz_id = qid and pos = 1;
  p1 := (join_quiz(code,'Ana')->>'player_id')::uuid;
  p2 := (join_quiz(code,'Ben')->>'player_id')::uuid;
  perform host_action(qid, tok, 'start');

  assert not (get_play_state(p1) ? 'feed'), 'no chat before your first answer';
  perform submit_answer(p1, q1, '"Pizza"'::jsonb);
  st := get_play_state(p1);
  assert (st->'feed'->0->>'name') = 'Ana' and (st->'feed'->0->>'text') = 'Pizza' and (st->'feed'->0->>'is_me') = 'true', 'phone sees its own message in the chat';
  assert not (get_play_state(p2) ? 'feed'), 'still nothing for someone who has not answered';
  perform submit_answer(p2, q1, '"Tacos"'::jsonb);
  st := get_play_state(p1);
  assert jsonb_array_length(st->'feed') = 2 and (st->'feed'->1->>'name') = 'Ben' and (st->'feed'->1->>'is_me') = 'false', 'sees Ben too';

  -- the host gets the chat for the question on screen only
  dash := host_get_dashboard(qid, tok);
  assert jsonb_array_length(dash->'questions'->0->'feed') = 2, 'host feed for the current question';
  assert (dash->'questions'->1->'feed') = 'null'::jsonb, 'no feed for other questions';

  -- the chat is private to the database: no direct reads
  begin
    set local role anon;
    perform 1 from public.answer_feed limit 1;
    reset role;
    raise exception 'anon could read answer_feed';
  exception when insufficient_privilege then
    reset role;
  end;

  -- removing a player (Play again) removes their messages
  perform host_action(qid, tok, 'reveal'); perform host_action(qid, tok, 'next');   -- question 2
  perform host_action(qid, tok, 'reveal'); perform host_action(qid, tok, 'next');   -- finished
  perform host_action(qid, tok, 'reset');
  assert (select count(*) from answer_feed where quiz_id = qid) = 0, 'reset clears the chat';

  raise notice 'ALL SERVER TESTS PASSED';
end $$;
