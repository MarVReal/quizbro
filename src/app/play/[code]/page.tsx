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
import { getQuizPublic, getResults, joinQuiz, nextQuestion, submitAnswer } from "@/lib/api";
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
  PlayQuestion,
  QuizPublic,
  Results,
  ReviewRow,
  SubmitResult,
} from "@/lib/types";

type Current = { question: PlayQuestion; total: number; score: number; secondsLeft: number };
type Feedback = { result: SubmitResult; question: PlayQuestion; score: number };
type Phase = "loading" | "missing" | "join" | "question" | "feedback" | "done";

const medal = (rank: number) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`);

function describeCorrect(q: PlayQuestion, correct: SubmitResult["correct"]): string {
  if (!correct) return "";
  if (q.type === "short_text") return (correct as string[]).join(" / ");
  return (correct as number[]).map((i) => q.options[i]).join(" + ");
}

export default function PlayPage({ params }: PageProps<"/play/[code]">) {
  const { code: rawCode } = use(params);
  const code = rawCode.toUpperCase();

  const [phase, setPhase] = useState<Phase>("loading");
  const [quiz, setQuiz] = useState<QuizPublic | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [current, setCurrent] = useState<Current | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [text, setText] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [streak, setStreak] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lock = useRef(false);
  const deadline = useRef(0);
  const latest = useRef({ selected, text, current, playerId });
  useEffect(() => {
    latest.current = { selected, text, current, playerId };
  });

  const loadNext = useCallback(async (pid: string) => {
    lock.current = false;
    setError(null);
    try {
      const n = await nextQuestion(pid);
      if (n.done) {
        const r = await getResults(pid);
        setResults(r);
        setPhase("done");
        if (r.rank <= 3 && r.player_count > 1) bigConfetti();
        else popConfetti();
        return;
      }
      deadline.current = performance.now() + n.seconds_left * 1000;
      setSelected([]);
      setText("");
      setSecondsLeft(n.seconds_left);
      setCurrent({ question: n.question, total: n.total, score: n.score, secondsLeft: n.seconds_left });
      setPhase("question");
    } catch (e) {
      throw e instanceof Error ? e : new Error("Something went wrong");
    }
  }, []);

  // Initial load: quiz info, then resume an existing player if this phone already joined.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const q = await getQuizPublic(code);
        if (cancelled) return;
        setQuiz(q);
        setName(getPlayerName());
        const pid = getPlayerId(code);
        if (pid) {
          try {
            setPlayerId(pid);
            await loadNext(pid);
            return;
          } catch {
            clearPlayerId(code);
            setPlayerId(null);
          }
        }
        setPhase("join");
      } catch {
        if (!cancelled) setPhase("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, loadNext]);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await joinQuiz(code, name);
      savePlayerName(name.trim());
      savePlayerId(code, r.player_id);
      setPlayerId(r.player_id);
      setStreak(0);
      await loadNext(r.player_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join");
    } finally {
      setBusy(false);
    }
  }

  const answer = useCallback(
    async (value: number[] | string | null): Promise<void> => {
      const { current: cur, playerId: pid } = latest.current;
      if (!cur || !pid || lock.current) return;
      lock.current = true;
      setBusy(true);
      try {
        // A null answer means "my timer hit zero". If our clock ran slightly ahead of the
        // server's it is refused, so retry briefly until the server agrees time is up.
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await submitAnswer(pid, cur.question.id, value);
            buzz(result.is_correct ? 40 : result.is_correct === false ? [60, 40, 60] : 20);
            if (result.is_correct) popConfetti();
            setStreak((s) => (result.is_correct ? s + 1 : result.is_correct === false ? 0 : s));
            setFeedback({ result, question: cur.question, score: cur.score + result.points });
            setPhase("feedback");
            return;
          } catch (e) {
            if (value === null && attempt < 6) {
              await new Promise((r) => setTimeout(r, 600));
              continue;
            }
            throw e;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("Already answered")) {
          await loadNext(pid).catch(() => undefined);
        } else {
          lock.current = false;
          setError(msg || "Couldn't send your answer. Try again.");
        }
      } finally {
        setBusy(false);
      }
    },
    [loadNext],
  );

  // Countdown. The server owns the real clock; this is just the display + auto-submit.
  useEffect(() => {
    if (phase !== "question" || !current) return;
    const id = setInterval(() => {
      const left = Math.max(0, (deadline.current - performance.now()) / 1000);
      setSecondsLeft(left);
      if (left <= 0) {
        clearInterval(id);
        const { selected: sel, text: txt, current: cur } = latest.current;
        if (!cur) return;
        const type = cur.question.type;
        if (type === "short_text") void answer(txt.trim() ? txt.trim() : null);
        else void answer(sel.length ? sel : null);
      }
    }, 100);
    return () => clearInterval(id);
  }, [phase, current, answer]);

  // Auto-advance after feedback.
  useEffect(() => {
    if (phase !== "feedback" || !playerId) return;
    const t = setTimeout(() => void loadNext(playerId).catch((e: Error) => setError(e.message)), 3200);
    return () => clearTimeout(t);
  }, [phase, playerId, loadNext, feedback]);

  const theme = asTheme(quiz?.theme);

  if (phase === "loading") {
    return (
      <Page theme={theme}>
        <Spinner />
      </Page>
    );
  }

  if (phase === "missing") {
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

  if (phase === "join" && quiz) {
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
            <form onSubmit={join} className="card mt-8 grid gap-3 p-5 text-left">
              <label htmlFor="name" className="font-display text-xl font-semibold">What should we call you?</label>
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
              {error && <ErrorBox>{error}</ErrorBox>}
              <button className="btn btn-primary py-3.5 text-lg" disabled={busy || !name.trim()}>
                {busy ? "Joining…" : "Let's go! 🚀"}
              </button>
            </form>
          </motion.div>
        </main>
      </Page>
    );
  }

  if (phase === "question" && current) {
    const q = current.question;
    const multi = q.type === "multiple_select";
    const typed = q.type === "short_text";
    const two = q.options.length <= 2;
    return (
      <Page theme={theme}>
        <main className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 pb-6 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="rounded-full bg-white/15 px-3 py-1.5 text-sm font-extrabold">
              {q.pos} / {current.total}
            </div>
            {streak >= 2 && (
              <motion.div initial={{ scale: 0.6 }} animate={{ scale: 1 }} className="rounded-full bg-[#ff7a1a] px-3 py-1.5 text-sm font-extrabold">
                🔥 {streak} in a row
              </motion.div>
            )}
            <div className="rounded-full bg-white/15 px-3 py-1.5 text-sm font-extrabold">
              ⭐ <AnimatedNumber value={current.score} />
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
                <TimerRing secondsLeft={secondsLeft} total={q.time_limit} />
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
                              setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort()));
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
              {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
            </motion.div>
          </AnimatePresence>
        </main>
      </Page>
    );
  }

  if (phase === "feedback" && feedback) {
    const { result, question } = feedback;
    const ok = result.is_correct;
    const poll = ok === null;
    const bg = poll ? "#118ab2" : ok ? "#06a77d" : "#ef476f";
    return (
      <Page theme={theme}>
        <main
          className={`mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-5 text-center ${ok === false ? "shake" : ""}`}
        >
          <motion.div
            initial={{ scale: 0.3, rotate: -20, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 14 }}
            className="grid h-36 w-36 place-items-center rounded-full text-7xl shadow-2xl"
            style={{ background: bg }}
          >
            {poll ? "📊" : ok ? "✅" : result.timed_out ? "⏰" : "❌"}
          </motion.div>
          <h1 className="font-display mt-6 text-4xl font-bold">
            {poll ? "Vote counted!" : ok ? "Correct!" : result.timed_out ? "Time's up!" : "Not quite"}
          </h1>
          {ok && (
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="font-display mt-2 text-3xl font-bold text-accent"
            >
              +{result.points.toLocaleString()}
            </motion.p>
          )}
          {ok === false && result.correct && (
            <p className="card mt-4 px-4 py-3 font-bold">
              Answer: <span className="text-accent">{describeCorrect(question, result.correct)}</span>
            </p>
          )}
          {streak >= 2 && ok && <p className="mt-3 font-extrabold">🔥 {streak} in a row!</p>}
          <p className="mt-6 text-lg font-bold text-white/80">
            Score: <AnimatedNumber value={feedback.score} className="text-white" />
          </p>
          <div className="mt-6 h-1.5 w-40 overflow-hidden rounded-full bg-white/20">
            <motion.div
              className="h-full bg-accent"
              initial={{ width: "0%" }}
              animate={{ width: "100%" }}
              transition={{ duration: 3.2, ease: "linear" }}
            />
          </div>
          <button
            className="btn btn-ghost mt-4"
            onClick={() => playerId && void loadNext(playerId).catch((e: Error) => setError(e.message))}
          >
            Next →
          </button>
          {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
        </main>
      </Page>
    );
  }

  if (phase === "done" && results) {
    return (
      <Page theme={theme}>
        <ResultsView
          results={results}
          onAgain={() => {
            clearPlayerId(code);
            setPlayerId(null);
            setResults(null);
            setStreak(0);
            setPhase("join");
          }}
        />
      </Page>
    );
  }

  return (
    <Page theme={theme}>
      <Spinner />
    </Page>
  );
}

function ResultsView({ results, onAgain }: { results: Results; onAgain: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <main className="mx-auto max-w-lg px-4 pb-14 pt-8 text-center">
      <Logo small />
      <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="mt-6">
        <p className="text-7xl">{results.rank <= 3 ? medal(results.rank) : "🎊"}</p>
        <h1 className="font-display mt-2 text-4xl font-bold">
          {results.rank === 1 ? "You won!" : "Quiz complete!"}
        </h1>
        <p className="mt-1 font-semibold text-white/75">{results.quiz.title}</p>
      </motion.div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Stat label="Score" value={<AnimatedNumber value={results.score} />} />
        <Stat label="Rank" value={`${results.rank}/${results.player_count}`} />
        <Stat label="Correct" value={results.correct} />
      </div>

      <section className="card mt-6 p-4 text-left">
        <h2 className="font-display mb-2 text-xl font-semibold">Leaderboard</h2>
        <ol className="grid gap-1.5">
          {results.leaderboard.map((r, i) => (
            <motion.li
              key={`${r.name}-${i}`}
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.05 * i }}
              className={`flex items-center gap-3 rounded-xl px-3 py-2 ${r.is_me ? "bg-accent font-extrabold text-accent-ink" : "bg-white/10 font-bold"}`}
            >
              <span className="w-8 text-center">{medal(r.rank)}</span>
              <span className="min-w-0 flex-1 truncate">{r.name}{r.is_me && " (you)"}</span>
              <span>{r.score.toLocaleString()}</span>
            </motion.li>
          ))}
        </ol>
      </section>

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
            {results.review.map((r) => (
              <ReviewItem key={r.pos} r={r} />
            ))}
          </ul>
        )}
      </section>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button className="btn btn-primary" onClick={onAgain}>Play as someone else</button>
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
