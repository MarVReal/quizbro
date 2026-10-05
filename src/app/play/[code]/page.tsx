"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AnimatedNumber,
  ErrorBox,
  Logo,
  Page,
  Spinner,
  TimerRing,
} from "@/components/ui";
import { AnswerComposer, type Cooldown } from "@/components/AnswerComposer";
import { BubbleCloud } from "@/components/BubbleCloud";
import { getPlayState, getQuizPublic, joinQuiz, submitAnswer } from "@/lib/api";
import {
  ANSWER_COOLDOWN_S,
  MAX_ANSWERS,
  MAX_CHARS,
  mergeBubbles,
  validateNextAnswer,
} from "@/lib/multi-answer";
import { bigConfetti, buzz, popConfetti } from "@/lib/fx";
import {
  clearPlayerId,
  getPlayerId,
  getPlayerName,
  savePlayerId,
  savePlayerName,
} from "@/lib/storage";
import { OPTION_STYLES, asTheme } from "@/lib/theme";
import type {
  LeaderboardRow,
  PlayQuestion,
  PlayState,
  QuizPublic,
  ReviewRow,
  RevealInfo,
} from "@/lib/types";

const POLL_MS = { lobby: 1500, question: 1000, reveal: 1500, finished: 5000 } as const;

const medal = (rank: number) =>
  rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

/** Whichever list is longer: the server's copy of my answers, or what I've sent since the last poll. */
const longest = (a: string[], b: string[]) => (b.length > a.length ? b : a);

function describeCorrect(q: PlayQuestion, correct: RevealInfo["correct"]): string {
  if (!correct) return "";
  if (q.type === "short_text") return (correct as string[]).join(" / ");
  return (correct as number[]).map((i) => q.options[i]).join(" + ");
}

export default function PlayPage({ params }: PageProps<"/play/[code]">) {
  const { code: rawCode } = use(params);
  const code = rawCode.toUpperCase();

  const [quiz, setQuiz] = useState<QuizPublic | null>(null);
  const [missing, setMissing] = useState(false);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [state, setState] = useState<PlayState | null>(null);
  const [name, setName] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);

  // Per-question local input.
  const [selected, setSelected] = useState<number[]>([]);
  const [text, setText] = useState("");
  // multi_answer: the one answer being typed, answers sent this question, and the cooldown between sends.
  const [draft, setDraft] = useState("");
  const [sentLocal, setSentLocal] = useState<string[]>([]);
  const [cooldown, setCooldown] = useState<Cooldown>({ key: 0, ends: 0 });
  const sending = useRef(false);
  const [locked, setLocked] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const deadline = useRef(0);
  const latest = useRef({ selected, text, draft, sentLocal, cooldown, locked, state, playerId });
  useEffect(() => {
    latest.current = { selected, text, draft, sentLocal, cooldown, locked, state, playerId };
  });

  const refresh = useCallback(async () => {
    const pid = latest.current.playerId;
    if (!pid) return;
    try {
      const s = await getPlayState(pid);
      setState(s);
      setOffline(false);
      if (s.status === "question" && !s.closed) {
        deadline.current = performance.now() + (s.seconds_left ?? 0) * 1000;
      }
      if (s.cooldown_left !== undefined && s.cooldown_left > 0.15) {
        // Only restart the ring when the server disagrees with our own clock by a real margin.
        const ends = performance.now() + s.cooldown_left * 1000;
        if (Math.abs(ends - latest.current.cooldown.ends) > 600) {
          setCooldown((c) => ({ key: c.key + 1, ends }));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("Player not found")) {
        // The host reset the game (or the player was removed): start over.
        clearPlayerId(code);
        setPlayerId(null);
        setState(null);
      } else {
        setOffline(true);
      }
    }
  }, [code]);

  // Initial load: quiz info, then resume an existing player on this phone.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const q = await getQuizPublic(code);
        if (cancelled) return;
        setQuiz(q);
        setName(getPlayerName());
        const pid = getPlayerId(code);
        if (pid) setPlayerId(pid);
      } catch {
        if (!cancelled) setMissing(true);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Poll the game state. The server decides what phase we're in; we just render it.
  useEffect(() => {
    if (!playerId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped) return;
      if (!document.hidden) await refresh();
      if (stopped) return;
      const status = latest.current.state?.status ?? "lobby";
      timer = setTimeout(loop, POLL_MS[status] + Math.random() * 250);
    };
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [playerId, refresh]);

  // New question => clear the local input.
  const questionId = state?.question?.id;
  const prevQuestionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected([]);
    setText("");
    setDraft("");
    setSentLocal([]);
    setLocked(false);
    setAnswerError(null);
    // The very first state of a page load can already carry a cooldown (refresh mid-cooldown):
    // only drop it when moving from one question to another.
    if (prevQuestionId.current !== undefined) setCooldown({ key: 0, ends: 0 });
    prevQuestionId.current = questionId;
  }, [questionId]);

  const answer = useCallback(
    async (value: number[] | string | string[]) => {
      const { state: st, playerId: pid, locked: already } = latest.current;
      const q = st?.question;
      if (!q || !pid || already) return;
      setLocked(true);
      setBusy(true);
      setAnswerError(null);
      try {
        await submitAnswer(pid, q.id, value);
        buzz(30);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (!msg.includes("Already answered")) {
          setLocked(false);
          setAnswerError(
            msg.includes("closed") || msg.includes("Time is up")
              ? "Time's up before that went through."
              : msg || "Couldn't send your answer. Try again.",
          );
        }
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [refresh],
  );

  // Multi-answer sends ONE answer at a time, then waits out a short cooldown (the server enforces it too).
  const sendOne = useCallback(
    async (raw: string) => {
      const { state: st, playerId: pid, sentLocal: local, cooldown: cd } = latest.current;
      const q = st?.question;
      if (!q || q.type !== "multi_answer" || !pid || sending.current) return;
      if (performance.now() < cd.ends) return;
      const limits = {
        maxAnswers: q.max_answers ?? MAX_ANSWERS.default,
        maxChars: q.max_chars ?? MAX_CHARS.default,
      };
      const mine = longest(st?.my_answers ?? [], local);
      const check = validateNextAnswer(raw, mine, limits);
      if (!check.ok) {
        setAnswerError(check.error);
        return;
      }
      sending.current = true;
      setBusy(true);
      setAnswerError(null);
      // Optimistic, like sending a message: the box clears and my answer joins the bubbles right
      // away. If the send fails, both are undone below and the text is handed back.
      setSentLocal([...mine, check.answer]);
      setDraft("");
      try {
        await submitAnswer(pid, q.id, check.answer);
        buzz(30);
        setCooldown((c) => ({ key: c.key + 1, ends: performance.now() + ANSWER_COOLDOWN_S * 1000 }));
        if (mine.length + 1 >= limits.maxAnswers) popConfetti();
      } catch (e) {
        setSentLocal(mine);
        setDraft((d) => (d === "" ? raw : d)); // unless they have already started the next one
        const msg = e instanceof Error ? e.message : "";
        setAnswerError(
          msg.includes("closed") || msg.includes("Time is up")
            ? "Time's up before that went through."
            : msg || "Couldn't send your answer. Try again.",
        );
      } finally {
        sending.current = false;
        setBusy(false);
        void refresh();
      }
    },
    [refresh],
  );

  // Local countdown (display only; the server enforces the real deadline) and
  // an auto-submit of whatever is selected/typed when the timer hits zero.
  const running = state?.status === "question" && !state.closed;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const left = Math.max(0, (deadline.current - performance.now()) / 1000);
      setSecondsLeft(left);
      if (left <= 0) {
        clearInterval(id);
        const { selected: sel, text: txt, locked: done, state: st } = latest.current;
        if (!st?.question || st.question.type === "multi_answer" || done) return;
        if (st.question.type === "short_text") {
          if (txt.trim()) void answer(txt.trim());
        } else if (sel.length) {
          void answer(sel);
        }
      }
    }, 100);
    return () => clearInterval(id);
  }, [running, questionId, answer, sendOne]);

  // Multi-answer: when time runs out, make one last attempt at whatever is typed but unsent. Keyed on
  // the server's "closed" flag too, because that can arrive before our own timer reaches zero. The
  // server still has the final say (it allows a second of grace); blanks, repeats and cooldowns are ignored.
  const timeIsUp = state?.status === "question" && !!state.closed && state.question?.type === "multi_answer";
  useEffect(() => {
    if (!timeIsUp) return;
    const typing = latest.current.draft;
    if (typing.trim()) void sendOne(typing);
  }, [timeIsUp, questionId, sendOne]);

  // Celebrate (or not) when the host reveals the answer.
  const revealKey = state?.status === "reveal" ? questionId : undefined;
  useEffect(() => {
    if (!revealKey) return;
    const r = latest.current.state?.reveal;
    if (r?.is_correct) {
      popConfetti();
      buzz(40);
    } else if (r?.is_correct === false) {
      buzz([60, 40, 60]);
    }
  }, [revealKey]);

  // Confetti for the podium.
  const finished = state?.status === "finished";
  useEffect(() => {
    if (!finished) return;
    const s = latest.current.state;
    if (s && (s.rank ?? 99) <= 3 && s.player_count > 1) bigConfetti();
    else popConfetti();
  }, [finished]);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setJoinError(null);
    try {
      const r = await joinQuiz(code, name);
      savePlayerName(name.trim());
      savePlayerId(code, r.player_id);
      latest.current.playerId = r.player_id;
      setState(null);
      setPlayerId(r.player_id);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "Couldn't join");
    } finally {
      setBusy(false);
    }
  }

  const theme = asTheme(state?.quiz.theme ?? quiz?.theme);

  if (booting) {
    return (
      <Page theme={theme}>
        <Spinner />
      </Page>
    );
  }

  if (missing || !quiz) {
    return (
      <Page>
        <div className="mx-auto max-w-md px-5 pt-16 text-center">
          <Logo />
          <p className="mt-10 text-6xl">🤔</p>
          <h1 className="font-display mt-3 text-3xl font-bold">Quiz not found</h1>
          <p className="mt-2 font-semibold text-white/75">
            Check the code <span className="font-bold text-accent">{code}</span> and try again.
          </p>
          <Link href="/" className="btn btn-primary mt-6">Enter a different code</Link>
        </div>
      </Page>
    );
  }

  // ───────── Not joined yet ─────────
  if (!playerId) {
    const started = quiz.status !== "lobby";
    return (
      <Page theme={theme}>
        <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10 text-center">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <Logo />
            <h1 className="font-display mt-10 text-4xl font-bold leading-tight">{quiz.title}</h1>
            {quiz.description && (
              <p className="mt-2 font-semibold text-white/75">{quiz.description}</p>
            )}
            <p className="mt-3 inline-block rounded-full bg-white/15 px-3 py-1 text-sm font-extrabold">
              {quiz.question_count} question{quiz.question_count === 1 ? "" : "s"}
            </p>
            {quiz.status === "finished" ? (
              <div className="card mt-8 p-6">
                <p className="text-5xl">🏁</p>
                <p className="font-display mt-2 text-2xl font-semibold">This game has ended</p>
                <Link href="/" className="btn btn-primary mt-4">Back home</Link>
              </div>
            ) : (
              <form onSubmit={join} className="card mt-8 grid gap-3 p-5 text-left">
                <label htmlFor="name" className="font-display text-xl font-semibold">
                  What should we call you?
                </label>
                <input
                  id="name"
                  className="field font-display text-2xl"
                  placeholder="Your nickname"
                  maxLength={24}
                  autoComplete="nickname"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                {started && (
                  <p className="text-sm font-bold text-white/70">
                    The game has already started. You&apos;ll jump in from the next question.
                  </p>
                )}
                {joinError && <ErrorBox>{joinError}</ErrorBox>}
                <button className="btn btn-primary py-3.5 text-lg" disabled={busy || !name.trim()}>
                  {busy ? "Joining…" : "Join the game 🚀"}
                </button>
              </form>
            )}
          </motion.div>
        </main>
      </Page>
    );
  }

  if (!state) {
    return (
      <Page theme={theme}>
        <Spinner label="Connecting" />
      </Page>
    );
  }

  const banner = offline ? (
    <div className="fixed inset-x-0 top-0 z-20 bg-[#ef476f] px-3 py-1.5 text-center text-sm font-extrabold">
      Reconnecting…
    </div>
  ) : null;

  // ───────── Lobby ─────────
  if (state.status === "lobby") {
    return (
      <Page theme={theme}>
        {banner}
        <Lobby state={state} />
      </Page>
    );
  }

  // ───────── Final results ─────────
  if (state.status === "finished") {
    return (
      <Page theme={theme}>
        {banner}
        <ResultsView
          state={state}
          onAgain={() => {
            clearPlayerId(code);
            setPlayerId(null);
            setState(null);
            setQuiz((q) => (q ? { ...q, status: "finished" } : q));
          }}
        />
      </Page>
    );
  }

  const q = state.question!;

  // ───────── Reveal: right/wrong + leaderboard ─────────
  if (state.status === "reveal") {
    return (
      <Page theme={theme}>
        {banner}
        <RevealView state={state} q={q} />
      </Page>
    );
  }

  // ───────── Question (running or closed, waiting for the reveal) ─────────
  const answered = state.answered || locked;
  const multi = q.type === "multiple_select";
  const typed = q.type === "short_text";
  const multiAnswer = q.type === "multi_answer";
  const mineSent = longest(state.my_answers ?? [], sentLocal);
  // The bubbles everyone has built, plus my own answers straight away (anonymous: text and counts only).
  const cloud = mergeBubbles(state.bubbles, mineSent);
  const two = q.options.length <= 2;
  const closed = !!state.closed;

  return (
    <Page theme={theme}>
      {banner}
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 pb-6 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="rounded-full bg-white/15 px-3 py-1.5 text-sm font-extrabold">
            {q.pos} / {state.quiz.question_count}
          </div>
          {state.streak >= 2 && (
            <div className="rounded-full bg-[#ff7a1a] px-3 py-1.5 text-sm font-extrabold">
              🔥 {state.streak} in a row
            </div>
          )}
          <div className="rounded-full bg-white/15 px-3 py-1.5 text-sm font-extrabold">
            ⭐ <AnimatedNumber value={state.score} />
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={q.id}
            initial={{ opacity: 0, x: 60 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -60 }}
            className="flex flex-1 flex-col"
          >
            <div className="my-4 flex items-start gap-4">
              <h1 className="font-display flex-1 text-3xl font-semibold leading-tight sm:text-4xl">
                {q.prompt}
              </h1>
              <TimerRing secondsLeft={closed ? 0 : secondsLeft} total={q.time_limit} />
            </div>

            {q.image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={q.image_url}
                alt=""
                referrerPolicy="no-referrer"
                className="mb-4 max-h-56 w-full rounded-2xl object-contain"
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
            )}

            {multiAnswer ? (
              <div className="flex flex-1 flex-col gap-3">
                {closed && (
                  <WaitCard
                    answered={mineSent.length > 0}
                    closed
                    count={state.answered_count ?? 0}
                    players={state.player_count}
                    compact
                  />
                )}
                {/* The bubbles open up once you've sent your first answer. Everyone's answers are anonymous. */}
                {cloud ? (
                  <BubbleCloud
                    data={cloud}
                    mine={mineSent}
                    emptyText="Your answer is on its way…"
                    className="relative min-h-[18rem] flex-1"
                  />
                ) : (
                  !closed && (
                    <div className="card grid flex-1 place-items-center px-6 py-8 text-center">
                      <div>
                        <p className="text-6xl" aria-hidden>
                          🫧
                        </p>
                        <p className="font-display mt-2 text-2xl font-semibold">Your turn!</p>
                        <p className="mt-1 font-semibold text-white/75">
                          Type an answer below. Answers are anonymous. Once you send yours, you&apos;ll see
                          everyone&apos;s answers grow as bubbles.
                        </p>
                      </div>
                    </div>
                  )
                )}
                {!closed && (
                  <AnswerComposer
                    className="sticky bottom-0 -mx-1 px-1 pb-1 pt-1"
                    sent={mineSent}
                    maxAnswers={q.max_answers ?? MAX_ANSWERS.default}
                    maxChars={q.max_chars ?? MAX_CHARS.default}
                    draft={draft}
                    onDraft={setDraft}
                    cooldown={cooldown}
                    busy={busy}
                    error={answerError}
                    onSend={(a) => void sendOne(a)}
                  />
                )}
              </div>
            ) : answered || closed ? (
              <WaitCard
                answered={answered}
                closed={closed}
                count={state.answered_count ?? 0}
                players={state.player_count}
              />
            ) : (
              <>
                <p className="mb-3 text-sm font-bold text-white/70">
                  {multi
                    ? "Select all that apply, then lock in"
                    : typed
                      ? "Type your answer"
                      : q.type === "poll"
                        ? "Poll, no points. Vote!"
                        : "Pick one"}
                </p>

                {typed ? (
                  <form
                    className="grid gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (text.trim()) void answer(text.trim());
                    }}
                  >
                    <input
                      className="field font-display text-2xl"
                      placeholder="Type here…"
                      autoComplete="off"
                      autoCapitalize="none"
                      maxLength={200}
                      autoFocus
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <button className="btn btn-primary py-4 text-xl" disabled={busy || !text.trim()}>
                      Lock it in 🔒
                    </button>
                  </form>
                ) : (
                  <>
                    <div className={`grid flex-1 content-start gap-3 ${two ? "" : "sm:grid-cols-2"}`}>
                      {q.options.map((opt, i) => {
                        const st = OPTION_STYLES[i];
                        const on = selected.includes(i);
                        return (
                          <motion.button
                            key={i}
                            type="button"
                            disabled={busy}
                            initial={{ opacity: 0, y: 18 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.05 * i }}
                            whileTap={{ scale: 0.96 }}
                            aria-pressed={multi ? on : undefined}
                            onClick={() => {
                              if (multi) {
                                setSelected((s) =>
                                  s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort(),
                                );
                              } else {
                                setSelected([i]);
                                void answer([i]);
                              }
                            }}
                            className="relative flex min-h-[4.5rem] items-center gap-3 rounded-2xl px-4 py-3 text-left text-lg font-extrabold leading-snug text-white transition disabled:opacity-60"
                            style={{
                              background: st.bg,
                              boxShadow: `0 6px 0 ${st.shadow}`,
                              outline: on ? "4px solid #fff" : "none",
                              outlineOffset: 2,
                            }}
                          >
                            <span className="font-display grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-black/25 text-lg">
                              {multi ? (on ? "✓" : st.letter) : st.letter}
                            </span>
                            <span className="min-w-0 break-words">{opt}</span>
                          </motion.button>
                        );
                      })}
                    </div>
                    {multi && (
                      <button
                        className="btn btn-primary mt-4 py-4 text-xl"
                        disabled={busy || selected.length === 0}
                        onClick={() => void answer(selected)}
                      >
                        Lock in {selected.length > 0 && `(${selected.length})`} 🔒
                      </button>
                    )}
                  </>
                )}
              </>
            )}
            {answerError && !multiAnswer && (
              <div className="mt-3">
                <ErrorBox>{answerError}</ErrorBox>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </Page>
  );
}

function WaitCard({
  answered,
  closed,
  count,
  players,
  compact = false,
}: {
  answered: boolean;
  closed: boolean;
  count: number;
  players: number;
  /** Smaller card, for when something else (like the bubbles) shares the screen. */
  compact?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`card mt-4 flex flex-col items-center text-center ${compact ? "gap-1.5 px-5 py-4" : "gap-3 px-6 py-10"}`}
    >
      <motion.span
        className={compact ? "text-4xl" : "text-6xl"}
        animate={closed ? { rotate: [0, -8, 8, 0] } : { scale: [1, 1.12, 1] }}
        transition={{ repeat: Infinity, duration: 1.8 }}
      >
        {closed ? "⏰" : "🔒"}
      </motion.span>
      <h2 className={`font-display font-bold ${compact ? "text-2xl" : "text-3xl"}`}>
        {closed ? "Time's up!" : "Locked in!"}
      </h2>
      <p className="font-semibold text-white/80">
        {closed
          ? answered
            ? "Your answer is in. Eyes on the big screen, the host will reveal the answer."
            : "No answer from you this round. The host will reveal the answer."
          : "Waiting for the timer to run out…"}
      </p>
      {!closed && (
        <p className="rounded-full bg-white/15 px-3 py-1 text-sm font-extrabold">
          {count} of {players} answered
        </p>
      )}
    </motion.div>
  );
}

/** Other players' names shown before the rest collapse into a "+N others" chip. */
const LOBBY_MAX_OTHERS = 11;

function Lobby({ state }: { state: PlayState }) {
  // You always come first (even if the server's recent-names list no longer includes you).
  const others = (state.players ?? []).filter((n) => n !== state.name).slice(0, LOBBY_MAX_OTHERS);
  const hidden = Math.max(0, state.player_count - 1 - others.length);
  const players = [state.name, ...others];
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center px-5 pb-10 pt-8 text-center">
      <Logo small />
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="mt-10"
      >
        <motion.p
          className="text-7xl"
          animate={{ rotate: [0, -10, 10, -6, 0], y: [0, -8, 0] }}
          transition={{ repeat: Infinity, duration: 3 }}
        >
          🎉
        </motion.p>
        <h1 className="font-display mt-3 text-4xl font-bold">You&apos;re in, {state.name}!</h1>
        <p className="mt-2 text-lg font-semibold text-white/80">{state.quiz.title}</p>
      </motion.div>

      <div className="card mt-8 w-full p-5">
        <div className="flex items-center justify-center gap-2 font-display text-xl font-semibold">
          Waiting for the host to start
          <span className="flex gap-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="h-2 w-2 rounded-full bg-accent"
                animate={{ opacity: [0.2, 1, 0.2], y: [0, -4, 0] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
              />
            ))}
          </span>
        </div>
        <p className="mt-1 text-sm font-bold text-white/65">
          {state.quiz.question_count} question{state.quiz.question_count === 1 ? "" : "s"} · get ready!
        </p>
      </div>

      <section className="mt-6 w-full" aria-label="Players in the lobby">
        <p className="mb-3 text-sm font-extrabold uppercase tracking-wider text-white/60">
          {state.player_count} player{state.player_count === 1 ? "" : "s"} here
        </p>
        <ul className="flex flex-wrap justify-center gap-2">
          <AnimatePresence>
            {players.map((n) => (
              <motion.li
                key={n}
                layout
                initial={{ opacity: 0, scale: 0.4 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.4 }}
                transition={{ type: "spring", stiffness: 420, damping: 22 }}
                className={`max-w-full truncate rounded-full px-3.5 py-1.5 text-sm font-extrabold ${
                  n === state.name ? "bg-accent text-accent-ink" : "bg-white/15"
                }`}
              >
                {n}
              </motion.li>
            ))}
            {hidden > 0 && (
              <li className="rounded-full border-2 border-dashed border-white/35 px-3.5 py-1.5 text-sm font-extrabold text-white/80">
                +{hidden} other{hidden === 1 ? "" : "s"}
              </li>
            )}
          </AnimatePresence>
        </ul>
      </section>
    </main>
  );
}

function LeaderboardList({
  rows,
  me,
}: {
  rows: LeaderboardRow[];
  me: { name: string; score: number; rank: number | null };
}) {
  const inList = rows.some((r) => r.is_me);
  return (
    <ol className="grid gap-1.5">
      {rows.map((r, i) => (
        <motion.li
          key={`${r.name}-${i}`}
          layout
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.06 * i }}
          className={`flex items-center gap-3 rounded-xl px-3 py-2 ${
            r.is_me ? "bg-accent font-extrabold text-accent-ink" : "bg-white/10 font-bold"
          }`}
        >
          <span className="w-8 text-center">{medal(r.rank)}</span>
          <span className="min-w-0 flex-1 truncate">
            {r.name}
            {r.is_me && " (you)"}
          </span>
          <span>{r.score.toLocaleString()}</span>
        </motion.li>
      ))}
      {!inList && me.rank && (
        <>
          <li className="text-center text-white/50" aria-hidden>⋯</li>
          <li className="flex items-center gap-3 rounded-xl bg-accent px-3 py-2 font-extrabold text-accent-ink">
            <span className="w-8 text-center">#{me.rank}</span>
            <span className="min-w-0 flex-1 truncate">{me.name} (you)</span>
            <span>{me.score.toLocaleString()}</span>
          </li>
        </>
      )}
    </ol>
  );
}

function RevealView({ state, q }: { state: PlayState; q: PlayQuestion }) {
  const r = state.reveal!;
  const ok = r.is_correct;
  const poll = ok === null;
  const bg = poll ? "#118ab2" : ok ? "#06a77d" : "#ef476f";
  const title = q.type === "multi_answer"
    ? r.answered
      ? "Answers counted!"
      : "Time's up"
    : poll
    ? r.answered
      ? "Vote counted!"
      : "Poll closed"
    : ok
      ? "Correct!"
      : r.answered
        ? "Not quite"
        : "No answer";
  return (
    <main
      className={`mx-auto flex min-h-dvh max-w-md flex-col items-center px-5 pb-10 pt-10 text-center ${ok === false ? "shake" : ""}`}
    >
      <motion.div
        initial={{ scale: 0.3, rotate: -20, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 14 }}
        className="grid h-32 w-32 place-items-center rounded-full text-6xl shadow-2xl"
        style={{ background: bg }}
      >
        {q.type === "multi_answer" ? "🫧" : poll ? "📊" : ok ? "✅" : r.answered ? "❌" : "⏰"}
      </motion.div>
      <h1 className="font-display mt-5 text-4xl font-bold">{title}</h1>
      {ok && (
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="font-display mt-1 text-3xl font-bold text-accent"
        >
          +{r.points.toLocaleString()}
        </motion.p>
      )}
      {r.correct && !ok && (
        <p className="card mt-4 px-4 py-3 font-bold">
          Answer: <span className="text-accent">{describeCorrect(q, r.correct)}</span>
        </p>
      )}
      {ok && state.streak >= 2 && <p className="mt-2 font-extrabold">🔥 {state.streak} in a row!</p>}

      {q.type === "multi_answer" && state.bubbles && (
        <div className="mt-6 w-full">
          <BubbleCloud data={state.bubbles} mine={state.my_answers} className="relative h-[24rem]" />
        </div>
      )}

      {!poll && (
        <section className="card mt-6 w-full p-4 text-left">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-display text-xl font-semibold">Leaderboard</h2>
            {state.rank && (
              <p className="text-sm font-bold text-white/70">
                You&apos;re #{state.rank} · <AnimatedNumber value={state.score} />
              </p>
            )}
          </div>
          <LeaderboardList
            rows={state.leaderboard}
            me={{ name: state.name, score: state.score, rank: state.rank }}
          />
        </section>
      )}

      <p className="mt-6 flex items-center gap-2 text-sm font-bold text-white/70">
        <motion.span
          className="h-2 w-2 rounded-full bg-accent"
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ repeat: Infinity, duration: 1.4 }}
        />
        Waiting for the host to continue…
      </p>
    </main>
  );
}

function ResultsView({ state, onAgain }: { state: PlayState; onAgain: () => void }) {
  const [open, setOpen] = useState(false);
  const rank = state.rank ?? state.player_count;
  const review = state.review ?? [];
  // A poll-only quiz has no scores, so skip the rank, stats and leaderboard.
  const pollOnly = review.length > 0 && review.every((r) => r.type === "poll" || r.type === "multi_answer");
  const votesOnly = review.length > 0 && review.every((r) => r.type === "poll");
  return (
    <main className="mx-auto max-w-lg px-4 pb-14 pt-8 text-center">
      <Logo small />
      <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="mt-6">
        <p className="text-7xl">{pollOnly ? (votesOnly ? "📊" : "💬") : rank <= 3 ? medal(rank) : "🎊"}</p>
        <h1 className="font-display mt-2 text-4xl font-bold">
          {pollOnly ? (votesOnly ? "Thanks for voting!" : "Thanks for joining in!") : rank === 1 ? "You won!" : "Quiz complete!"}
        </h1>
        <p className="mt-1 font-semibold text-white/75">{state.quiz.title}</p>
      </motion.div>

      {!pollOnly && (
        <>
          <div className="mt-6 grid grid-cols-3 gap-3">
            <Stat label="Score" value={<AnimatedNumber value={state.score} />} />
            <Stat label="Rank" value={`${rank}/${state.player_count}`} />
            <Stat label="Correct" value={state.correct} />
          </div>

          <section className="card mt-6 p-4 text-left">
            <h2 className="font-display mb-2 text-xl font-semibold">Leaderboard</h2>
            <LeaderboardList
              rows={state.leaderboard}
              me={{ name: state.name, score: state.score, rank: state.rank }}
            />
          </section>
        </>
      )}

      <section className="card mt-4 p-4 text-left">
        <button
          className="font-display flex w-full items-center justify-between text-xl font-semibold"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Review your answers <span>{open ? "−" : "+"}</span>
        </button>
        {open && (
          <ul className="mt-3 grid gap-2">
            {review.map((r) => (
              <ReviewItem key={r.pos} r={r} />
            ))}
          </ul>
        )}
      </section>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button className="btn btn-primary" onClick={onAgain}>Done</button>
        <Link href="/create" className="btn btn-ghost">Make your own quiz ✨</Link>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card px-2 py-3">
      <p className="font-display text-3xl font-bold">{value}</p>
      <p className="text-xs font-extrabold uppercase tracking-wider text-white/60">{label}</p>
    </div>
  );
}

function ReviewItem({ r }: { r: ReviewRow }) {
  const show = (v: ReviewRow["answer"] | ReviewRow["correct"]) => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v;
    if (r.type === "multi_answer") return (v as string[]).join(", ") || "—";
    if (r.type === "short_text") return (v as unknown as string[]).join(" / ");
    return (v as number[]).map((i) => r.options[i]).join(" + ") || "—";
  };
  return (
    <li className="rounded-xl bg-white/10 p-3 text-sm">
      <p className="font-extrabold">
        {r.is_correct === null ? "📊" : r.is_correct ? "✅" : "❌"} {r.pos}. {r.prompt}
      </p>
      <p className="mt-1 font-semibold text-white/80">You: {show(r.answer)}</p>
      {r.is_correct === false && r.correct && (
        <p className="font-semibold text-accent">Correct: {show(r.correct)}</p>
      )}
      {r.points > 0 && <p className="font-bold text-white/60">+{r.points} pts</p>}
    </li>
  );
}
