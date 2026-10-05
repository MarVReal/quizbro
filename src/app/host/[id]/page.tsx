"use client";

import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AnimatedNumber,
  Confirm,
  ErrorBox,
  Logo,
  Page,
  Spinner,
  TimerRing,
} from "@/components/ui";
import { hostAction, hostDashboard } from "@/lib/api";
import { bigConfetti } from "@/lib/fx";
import { getMyQuizzes, saveMyQuiz } from "@/lib/storage";
import { OPTION_STYLES, asTheme } from "@/lib/theme";
import {
  QUESTION_TYPES,
  type HostAction,
  type HostDashboard,
  type HostPlayer,
  type HostQuestion,
} from "@/lib/types";

const POLL_MS = 1000;

function tokenFromHash(): string {
  const m = window.location.hash.match(/[#&]t=([a-f0-9]+)/i);
  return m ? m[1] : "";
}

/** Players sorted by score with competition ranking (ties share a rank). */
function ranked(players: HostPlayer[]) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let rank = 0;
  return sorted.map((p, i) => {
    if (i === 0 || sorted[i - 1].score !== p.score) rank = i + 1;
    return { ...p, rank };
  });
}

const medal = (rank: number) =>
  rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : String(rank);

export default function HostPage({ params }: PageProps<"/host/[id]">) {
  const { id } = use(params);
  const [data, setData] = useState<HostDashboard | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fatal, setFatal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"players" | "questions">("players");
  const [showJoin, setShowJoin] = useState(false);
  const [updated, setUpdated] = useState(0);
  const [now, setNow] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const deadline = useRef(0);
  const tokenRef = useRef("");
  const firstLoad = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const d = await hostDashboard(id, tokenRef.current);
      setData(d);
      setError(null);
      setUpdated(Date.now());
      if (d.state.status === "question" && !d.state.closed) {
        deadline.current = performance.now() + d.state.seconds_left * 1000;
      }
      if (firstLoad.current) {
        firstLoad.current = false;
        saveMyQuiz({
          id,
          code: d.quiz.code,
          title: d.quiz.title,
          hostToken: tokenRef.current,
          createdAt: Date.now(),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Connection problem";
      if (firstLoad.current && msg.includes("Invalid host link")) {
        setFatal(true);
      }
      setError(msg);
    }
  }, [id]);

  useEffect(() => {
    const t = tokenFromHash() || getMyQuizzes().find((q) => q.id === id)?.hostToken || "";
    tokenRef.current = t;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(t);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped) return;
      if (!document.hidden) await refresh();
      if (stopped) return;
      timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, refresh]);

  // One-second ticker for the LIVE badge and "answering now" highlights.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const status = data?.state.status;
  const running = status === "question" && !data?.state.closed;
  const currentPos = data?.state.current_pos;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(
      () => setSecondsLeft(Math.max(0, (deadline.current - performance.now()) / 1000)),
      100,
    );
    return () => clearInterval(t);
  }, [running, currentPos]);

  // Confetti when the game finishes.
  useEffect(() => {
    if (status === "finished") bigConfetti();
  }, [status]);

  const act = useCallback(
    async (action: HostAction) => {
      setBusy(true);
      setActionError(null);
      try {
        await hostAction(id, tokenRef.current, action);
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "That didn't work, try again");
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [id, refresh],
  );

  // The one thing the host should press next. Space / → triggers it, handy on a laptop.
  const primary = useMemo<{ label: string; action: HostAction } | null>(() => {
    if (!data) return null;
    const { status: st, closed, current_pos } = data.state;
    if (st === "lobby") {
      return data.players.length ? { label: "Start the game 🚀", action: "start" } : null;
    }
    if (st === "question") return closed ? { label: "Reveal answer 👀", action: "reveal" } : null;
    if (st === "reveal") {
      return current_pos >= data.question_count
        ? { label: "Finish quiz 🏁", action: "next" }
        : { label: "Next question →", action: "next" };
    }
    return null;
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(input|textarea|select|button)$/i.test(el.tagName)) return;
      if ((e.key === " " || e.key === "ArrowRight") && primary && !busy) {
        e.preventDefault();
        void act(primary.action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary, busy, act]);

  if (fatal) {
    return (
      <Page>
        <div className="mx-auto max-w-md px-5 pt-16 text-center">
          <Logo />
          <div className="mt-8">
            <ErrorBox>
              This host link isn&apos;t valid. Use the private QR or link from when you created the quiz.
            </ErrorBox>
          </div>
          <Link href="/" className="btn btn-primary mt-6">Back home</Link>
        </div>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page>
        <Spinner />
      </Page>
    );
  }

  const origin = window.location.origin;
  const playUrl = `${origin}/play/${data.quiz.code}`;
  const live = now - updated < POLL_MS * 4 && !error;
  const cur = data.state.current_pos;
  const q = cur > 0 ? data.questions[cur - 1] : undefined;
  // Polls have no scores or right answers, so they get no leaderboard or per-question breakdown.
  const pollOnly = data.questions.length > 0 && data.questions.every((x) => x.type === "poll");
  const showOverview =
    (data.state.status === "reveal" && q?.type !== "poll") ||
    (data.state.status === "finished" && !pollOnly);

  function exportCsv() {
    if (!data) return;
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [
      ["Rank", "Name", "Score", "Answered", "Correct"],
      ...ranked(data.players).map((p) => [p.rank, p.name, p.score, p.answered, p.correct]),
    ];
    const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `quisddad-${data.quiz.code}-results.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Page theme={asTheme(data.quiz.theme)}>
      <main className="mx-auto max-w-4xl px-4 pb-36 pt-5">
        <header className="mb-5 flex items-center justify-between gap-3">
          <Logo small />
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost px-3 py-1.5 text-sm" onClick={() => setShowJoin(true)}>
              Join QR
            </button>
            <span
              className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-extrabold ${live ? "bg-[#06a77d]" : "bg-[#ef476f]"}`}
              role="status"
            >
              <span className={`h-2 w-2 rounded-full bg-white ${live ? "animate-pulse" : ""}`} />
              {live ? "LIVE" : "RECONNECTING…"}
            </span>
          </div>
        </header>

        <div className="mb-5 min-w-0">
          <h1 className="font-display truncate text-3xl font-bold sm:text-4xl">{data.quiz.title}</h1>
          <p className="font-semibold text-white/70">
            Join code{" "}
            <span className="font-display font-bold tracking-widest text-accent">{data.quiz.code}</span>
            {" · "}
            {data.players.length} player{data.players.length === 1 ? "" : "s"}
          </p>
        </div>

        {actionError && (
          <div className="mb-4">
            <ErrorBox>{actionError}</ErrorBox>
          </div>
        )}

        <AnimatePresence mode="wait">
          <motion.div
            key={`${data.state.status}-${cur}`}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.22 }}
          >
            {data.state.status === "lobby" && <LobbyStage data={data} playUrl={playUrl} />}
            {data.state.status === "question" && q && (
              <QuestionStage data={data} q={q} secondsLeft={secondsLeft} now={now} />
            )}
            {data.state.status === "reveal" && q && <RevealStage data={data} q={q} />}
            {data.state.status === "finished" && <FinishedStage data={data} pollOnly={pollOnly} />}
          </motion.div>
        </AnimatePresence>

        {/* Hidden mid-question so live scores can't give the answer away on a shared screen. */}
        {showOverview && (
          <section className="mt-10">
            <div className="flex items-center justify-between gap-3">
              <div role="tablist" className="inline-flex rounded-full bg-black/25 p-1">
                {(["players", "questions"] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={`rounded-full px-5 py-2 text-sm font-extrabold transition ${tab === t ? "bg-accent text-accent-ink" : "text-white/80"}`}
                  >
                    {t === "players" ? "Leaderboard" : "Answers by question"}
                  </button>
                ))}
              </div>
              <button
                className="text-sm font-bold text-white/70 hover:text-white"
                onClick={exportCsv}
                disabled={data.players.length === 0}
              >
                ⬇ CSV
              </button>
            </div>
            <div className="mt-4">
              {tab === "players" ? (
                <Leaderboard data={data} now={now} />
              ) : (
                <ul className="grid gap-4">
                  {data.questions.map((qq) => (
                    <QuestionCard key={qq.id} q={qq} players={data.players.length} />
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
      </main>

      {/* Sticky control bar: the one thing the host needs to press next. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-white/15 bg-black/45 backdrop-blur-xl">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <p className="min-w-0 truncate text-sm font-bold text-white/75">
            {data.state.status === "lobby" &&
              (data.players.length ? `${data.players.length} ready` : "Waiting for players to scan…")}
            {data.state.status === "question" &&
              `Question ${cur} of ${data.question_count} · ${data.state.closed ? "timer ended" : "timer running"}`}
            {data.state.status === "reveal" && `Question ${cur} of ${data.question_count} · answer shown`}
            {data.state.status === "finished" && "Game over"}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {data.state.status === "question" && !data.state.closed && (
              <button className="btn btn-ghost px-4 py-2.5" disabled={busy} onClick={() => void act("close")}>
                End timer
              </button>
            )}
            {data.state.status === "finished" && (
              <Confirm
                label="Remove everyone & restart?"
                className="btn btn-ghost px-4 py-2.5"
                onConfirm={() => void act("reset")}
              >
                Play again
              </Confirm>
            )}
            {primary && (
              <button
                className="btn btn-primary px-6 py-3 text-lg"
                disabled={busy}
                onClick={() => void act(primary.action)}
              >
                {busy ? "…" : primary.label}
              </button>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showJoin && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="stage fixed inset-0 z-50 grid place-items-center p-6 text-center"
            data-theme={data.quiz.theme}
            onClick={() => setShowJoin(false)}
          >
            <div>
              <h2 className="font-display text-4xl font-bold sm:text-6xl">{data.quiz.title}</h2>
              <div className="mx-auto mt-6 inline-block rounded-3xl bg-white p-5 shadow-2xl">
                <QRCodeSVG
                  value={playUrl}
                  size={Math.min(420, window.innerWidth - 100)}
                  marginSize={0}
                  fgColor="#1a0b36"
                />
              </div>
              <p className="mt-6 text-xl font-bold text-white/80">Scan to play, or enter code</p>
              <p className="font-display text-7xl font-bold tracking-[0.25em] text-accent">{data.quiz.code}</p>
              <p className="mt-6 text-sm font-semibold text-white/60">Tap anywhere to close</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <footer className="mx-auto max-w-4xl px-4 pb-28 text-center">
        <Link
          href={`/share/${id}#t=${token}`}
          className="text-sm font-bold text-white/60 hover:text-white"
        >
          QR codes &amp; share links
        </Link>
      </footer>
    </Page>
  );
}

// ───────────────────────── Stages ─────────────────────────

/** Names shown in the lobby before the rest collapse into a "+N others" chip. */
const LOBBY_MAX_NAMES = 24;

function LobbyStage({ data, playUrl }: { data: HostDashboard; playUrl: string }) {
  const players = data.players;
  const shown = players.slice(0, LOBBY_MAX_NAMES);
  const hidden = players.length - shown.length;
  const seconds = data.questions.reduce((s, q) => s + q.time_limit, 0);
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <section className="card flex flex-col items-center gap-3 self-start p-6 text-center">
        <span className="rounded-full bg-accent px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-accent-ink">
          Scan to join
        </span>
        <div className="rounded-3xl bg-white p-4 shadow-xl">
          <QRCodeSVG value={playUrl} size={220} marginSize={0} fgColor="#1a0b36" />
        </div>
        <p className="max-w-full break-all text-sm font-bold text-white/70">
          or enter the code at {new URL(playUrl).host}
        </p>
        <p className="font-display text-5xl font-bold tracking-[0.25em] text-accent">{data.quiz.code}</p>
      </section>

      <section className="card min-w-0 p-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-2xl font-semibold">Who&apos;s here</h2>
          <p className="font-display text-4xl font-bold">
            <AnimatedNumber value={players.length} />
          </p>
        </div>
        <p className="text-sm font-bold text-white/60">
          {data.question_count} question{data.question_count === 1 ? "" : "s"} · about{" "}
          {Math.max(1, Math.round(seconds / 60))} min
        </p>
        {players.length === 0 ? (
          <div className="mt-8 text-center">
            <motion.p
              className="text-6xl"
              animate={{ y: [0, -10, 0] }}
              transition={{ repeat: Infinity, duration: 2 }}
            >
              📱
            </motion.p>
            <p className="font-display mt-3 text-xl font-semibold">Waiting for players…</p>
            <p className="font-semibold text-white/65">They&apos;ll pop up here the moment they scan.</p>
          </div>
        ) : (
          <ul className="mt-4 flex flex-wrap gap-2">
            <AnimatePresence>
              {shown.map((p) => (
                <motion.li
                  key={p.id}
                  layout
                  initial={{ opacity: 0, scale: 0.4 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.4 }}
                  transition={{ type: "spring", stiffness: 420, damping: 22 }}
                  className="max-w-full truncate rounded-full bg-white/15 px-4 py-2 text-lg font-extrabold"
                  title={p.name}
                >
                  {p.name}
                </motion.li>
              ))}
              {hidden > 0 && (
                <li className="rounded-full border-2 border-dashed border-white/35 px-4 py-2 text-lg font-extrabold text-white/80">
                  +{hidden} other{hidden === 1 ? "" : "s"}
                </li>
              )}
            </AnimatePresence>
          </ul>
        )}
        <p className="mt-6 text-sm font-semibold text-white/60">
          Players stay on a waiting screen until you press Start. Tip: press{" "}
          <kbd className="rounded bg-white/15 px-1.5">Space</kbd> to start, reveal and advance.
        </p>
      </section>
    </div>
  );
}

function QuestionHeader({ q, total }: { q: HostQuestion; total: number }) {
  const meta = QUESTION_TYPES.find((t) => t.id === q.type)!;
  return (
    <p className="text-xs font-extrabold uppercase tracking-wider text-white/60">
      Question {q.pos} of {total} · {meta.emoji} {meta.label}
      {q.type !== "poll" && ` · up to ${q.points} pts`}
    </p>
  );
}

function QuestionStage({
  data,
  q,
  secondsLeft,
  now,
}: {
  data: HostDashboard;
  q: HostQuestion;
  secondsLeft: number;
  now: number;
}) {
  const closed = data.state.closed;
  const players = data.players;
  const total = players.length;
  const answered = players.filter((p) => p.answered_current).length;
  return (
    <section className="card p-5 sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <QuestionHeader q={q} total={data.question_count} />
          <h2 className="font-display mt-2 text-3xl font-semibold leading-tight sm:text-5xl">{q.prompt}</h2>
        </div>
        <TimerRing secondsLeft={closed ? 0 : secondsLeft} total={q.time_limit} size={96} />
      </div>

      {q.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={q.image_url}
          alt=""
          referrerPolicy="no-referrer"
          className="mt-4 max-h-64 w-full rounded-2xl object-contain"
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
      )}

      <div className="mt-5">
        <div className="mb-1.5 flex items-center justify-between text-sm font-extrabold">
          <span>
            {answered} / {total} answered
          </span>
          <span className="text-white/60">
            {closed
              ? "Timer ended. Tap Reveal when ready."
              : q.type === "poll"
                ? "Votes update live"
                : "Answers stay hidden until you reveal"}
          </span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-white/15">
          <motion.div
            className="h-full bg-accent"
            animate={{ width: `${total ? (answered / total) * 100 : 0}%` }}
            transition={{ type: "spring", stiffness: 140, damping: 22 }}
          />
        </div>
      </div>

      {q.type === "short_text" ? (
        <div className="card mt-5 p-5 text-center">
          <p className="text-4xl">⌨️</p>
          <p className="font-display mt-1 text-xl font-semibold">Players are typing their answers</p>
          {closed && q.texts && q.texts.length > 0 && (
            <ul className="mt-3 flex flex-wrap justify-center gap-2">
              {q.texts.map((t) => (
                <li key={t.text} className="rounded-full bg-white/15 px-3 py-1 text-sm font-extrabold">
                  {t.text} {t.count > 1 && <span className="opacity-70">×{t.count}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : q.type === "poll" ? (
        <PollChart q={q} />
      ) : (
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {q.options.map((opt, i) => {
            const st = OPTION_STYLES[i];
            const n = q.counts?.[i] ?? 0;
            return (
              <li
                key={i}
                className="relative flex min-h-16 items-center gap-3 overflow-hidden rounded-2xl px-4 py-3 text-lg font-extrabold"
                style={{ background: st.bg, boxShadow: `0 5px 0 ${st.shadow}` }}
              >
                <span className="font-display grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-black/25 text-lg">
                  {st.letter}
                </span>
                <span className="min-w-0 flex-1 break-words">{opt}</span>
                {closed && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="font-display rounded-lg bg-black/30 px-2.5 py-0.5 text-xl"
                  >
                    {n}
                  </motion.span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5">
        <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">
          {closed ? "Who answered" : "Waiting on"}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {players.slice(0, 80).map((p) => {
            const justNow = p.last_active && now - new Date(p.last_active).getTime() < 3000;
            return (
              <li
                key={p.id}
                className={`rounded-full px-3 py-1 text-sm font-extrabold transition ${
                  p.answered_current ? "bg-[#06a77d]" : "bg-white/10 text-white/70"
                } ${justNow ? "ring-2 ring-white" : ""}`}
              >
                {p.answered_current ? "✓ " : ""}
                {p.name}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** Live vertical bar graph of poll votes; the host dashboard refreshes every second so it moves as people vote. */
function PollChart({ q }: { q: HostQuestion }) {
  const counts = q.options.map((_, i) => q.counts?.[i] ?? 0);
  const votes = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  return (
    <div
      className="mt-5 rounded-2xl bg-black/20 p-4 sm:p-5"
      role="img"
      aria-label={`Poll results: ${q.options.map((o, i) => `${o}, ${counts[i]} vote${counts[i] === 1 ? "" : "s"}`).join("; ")}`}
    >
      <div className="flex h-60 items-end gap-3 border-b-2 border-white/25 px-1 sm:gap-5">
        {counts.map((n, i) => {
          const st = OPTION_STYLES[i];
          const pct = votes ? Math.round((n / votes) * 100) : 0;
          return (
            <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center">
              <motion.div
                className="relative w-full max-w-24 rounded-t-xl"
                style={{ background: st.bg, minHeight: 6 }}
                initial={{ height: 0 }}
                animate={{ height: `${(n / max) * 82}%` }}
                transition={{ type: "spring", stiffness: 140, damping: 20 }}
              >
                <div className="absolute inset-x-0 bottom-full mb-1 text-center leading-tight">
                  <p className="font-display text-2xl font-bold">{n}</p>
                  <p className="text-xs font-extrabold text-white/70">{pct}%</p>
                </div>
              </motion.div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex gap-3 px-1 sm:gap-5">
        {q.options.map((opt, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
            <span
              className="font-display grid h-8 w-8 place-items-center rounded-lg text-sm font-bold"
              style={{ background: OPTION_STYLES[i].bg }}
              aria-hidden
            >
              {OPTION_STYLES[i].letter}
            </span>
            <span className="line-clamp-2 w-full break-words text-sm font-extrabold">{opt}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-sm font-bold text-white/60">
        {votes} vote{votes === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function RevealStage({ data, q }: { data: HostDashboard; q: HostQuestion }) {
  const correctSet = new Set(q.type === "short_text" ? [] : (q.correct as number[]));
  const max = Math.max(1, ...(q.counts ?? [0]));
  const pctRight = q.answered ? Math.round((q.right / q.answered) * 100) : null;
  return (
    <section className="card p-5 sm:p-7">
      <QuestionHeader q={q} total={data.question_count} />
      <h2 className="font-display mt-2 text-3xl font-semibold leading-tight">{q.prompt}</h2>

      <div className="mt-3 flex flex-wrap gap-2 text-sm font-extrabold">
        <span className="rounded-full bg-white/15 px-3 py-1">
          {q.answered}/{data.players.length} answered
        </span>
        {pctRight !== null && q.type !== "poll" && (
          <span className={`rounded-full px-3 py-1 ${pctRight >= 60 ? "bg-[#06a77d]" : "bg-[#ef476f]"}`}>
            {pctRight}% got it right
          </span>
        )}
        {q.avg_time_ms !== null && (
          <span className="rounded-full bg-white/15 px-3 py-1">avg {(q.avg_time_ms / 1000).toFixed(1)}s</span>
        )}
      </div>

      {q.type === "short_text" ? (
        <div className="mt-5">
          <p className="mb-2 text-sm font-bold text-white/70">Correct answer</p>
          <p className="font-display rounded-2xl bg-[#06a77d] px-4 py-3 text-3xl font-bold">
            ✓ {(q.correct as string[]).join(" / ")}
          </p>
          {q.texts && q.texts.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2">
              {q.texts.map((t) => (
                <li
                  key={t.text}
                  className={`rounded-full px-3 py-1 text-sm font-extrabold ${t.is_correct ? "bg-[#06a77d]" : "bg-white/15"}`}
                >
                  {t.text} {t.count > 1 && <span className="opacity-70">×{t.count}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : q.type === "poll" ? (
        <PollChart q={q} />
      ) : (
        <ul className="mt-5 grid gap-2.5">
          {q.options.map((opt, i) => {
            const st = OPTION_STYLES[i];
            const n = q.counts?.[i] ?? 0;
            const right = correctSet.has(i);
            const dim = q.type !== "poll" && !right;
            return (
              <li key={i} className="flex items-center gap-3">
                <span
                  className="font-display grid h-9 w-9 shrink-0 place-items-center rounded-lg text-base font-bold"
                  style={{ background: st.bg }}
                  aria-hidden
                >
                  {st.letter}
                </span>
                <div
                  className={`relative h-11 min-w-0 flex-1 overflow-hidden rounded-xl bg-black/25 ${right ? "ring-2 ring-[#4be3a6]" : ""}`}
                >
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-xl"
                    style={{ background: right ? "#06a77d" : st.bg, opacity: dim ? 0.4 : 1 }}
                    initial={{ width: 0 }}
                    animate={{ width: `${(n / max) * 100}%` }}
                    transition={{ type: "spring", stiffness: 110, damping: 20 }}
                  />
                  <span className="absolute inset-0 flex items-center px-3 text-base font-extrabold">
                    <span className="truncate">{opt}</span>
                    {right && <span className="ml-2">✓</span>}
                  </span>
                </div>
                <span className="font-display w-9 text-right text-xl font-bold">{n}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FinishedStage({ data, pollOnly }: { data: HostDashboard; pollOnly: boolean }) {
  if (pollOnly) {
    return (
      <section className="card p-6 text-center">
        <p className="text-5xl">📊</p>
        <h2 className="font-display mt-2 text-4xl font-bold sm:text-5xl">Poll complete</h2>
        <p className="mt-4 font-semibold text-white/70">
          {data.players.length} participant{data.players.length === 1 ? "" : "s"} voted. Press Play again to
          reuse this poll with a fresh lobby.
        </p>
      </section>
    );
  }
  const rows = ranked(data.players);
  const podium = [rows[1], rows[0], rows[2]]; // 2nd · 1st · 3rd
  const heights = ["h-28", "h-40", "h-20"];
  return (
    <section className="card p-6 text-center">
      <p className="text-5xl">🏆</p>
      <h2 className="font-display mt-2 text-4xl font-bold sm:text-5xl">Final results</h2>
      {rows.length === 0 ? (
        <p className="mt-4 font-semibold text-white/70">Nobody played this round.</p>
      ) : (
        <div className="mx-auto mt-8 grid max-w-xl grid-cols-3 items-end gap-3">
          {podium.map((p, i) =>
            p ? (
              <motion.div
                key={p.id}
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 + (i === 1 ? 0.5 : i === 0 ? 0.25 : 0), type: "spring" }}
                className="flex flex-col items-center"
              >
                <p className="font-display max-w-full truncate text-lg font-bold">{p.name}</p>
                <p className="font-display text-xl font-bold text-accent">{p.score.toLocaleString()}</p>
                <div
                  className={`mt-2 grid w-full place-items-center rounded-t-2xl bg-white/15 text-4xl ${heights[i]}`}
                >
                  {medal(p.rank)}
                </div>
              </motion.div>
            ) : (
              <div key={`empty-${i}`} />
            ),
          )}
        </div>
      )}
      <p className="mt-6 text-sm font-semibold text-white/65">
        The full leaderboard and per-question answers are below. Press Play again to reuse this quiz
        with a fresh lobby.
      </p>
    </section>
  );
}

// ───────────────────────── Overview (below the stage) ─────────────────────────

function Leaderboard({ data, now }: { data: HostDashboard; now: number }) {
  if (data.players.length === 0) {
    return (
      <div className="card p-10 text-center">
        <p className="font-display text-2xl font-semibold">No players yet</p>
      </div>
    );
  }
  const rows = ranked(data.players);
  const top = Math.max(1, ...rows.map((p) => p.score));
  return (
    <ol className="grid gap-2">
      {rows.map((p) => {
        const active = p.last_active && now - new Date(p.last_active).getTime() < 20000;
        const pct = data.question_count ? (p.answered / data.question_count) * 100 : 0;
        return (
          <motion.li
            layout
            key={p.id}
            transition={{ type: "spring", stiffness: 400, damping: 34 }}
            className="card relative overflow-hidden px-4 py-3"
          >
            <div
              className="absolute inset-y-0 left-0 bg-white/10"
              style={{ width: `${(p.score / top) * 100}%`, transition: "width .6s" }}
              aria-hidden
            />
            <div className="relative flex items-center gap-3">
              <span className="font-display w-9 text-center text-xl font-bold">{medal(p.rank)}</span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-lg font-extrabold">
                  {p.name}
                  {active && (
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#4be3a6]" title="Active now" />
                  )}
                </p>
                <div className="mt-1 flex items-center gap-2 text-xs font-bold text-white/65">
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/20">
                    <div className="h-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
                  </div>
                  {p.answered}/{data.question_count} · {p.correct} correct
                </div>
              </div>
              <span className="font-display text-2xl font-bold">
                <AnimatedNumber value={p.score} />
              </span>
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

function QuestionCard({ q, players }: { q: HostQuestion; players: number }) {
  const meta = QUESTION_TYPES.find((t) => t.id === q.type)!;
  const correctSet = new Set(q.type === "short_text" ? [] : (q.correct as number[]));
  const max = Math.max(1, ...(q.counts ?? [0]));
  const pctRight = q.answered ? Math.round((q.right / q.answered) * 100) : null;
  return (
    <li className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-extrabold uppercase tracking-wider text-white/60">
            Q{q.pos} · {meta.emoji} {meta.label}
          </p>
          <h3 className="font-display mt-0.5 text-xl font-semibold leading-snug">{q.prompt}</h3>
        </div>
        <div className="shrink-0 text-right text-sm font-bold text-white/75">
          <p>
            {q.answered}/{players} answered
          </p>
          {pctRight !== null && q.type !== "poll" && (
            <p className={pctRight >= 60 ? "text-[#4be3a6]" : "text-[#ffb3be]"}>{pctRight}% right</p>
          )}
          {q.avg_time_ms !== null && <p>avg {(q.avg_time_ms / 1000).toFixed(1)}s</p>}
        </div>
      </div>

      {q.type === "short_text" ? (
        <div className="mt-3">
          <p className="mb-2 text-sm font-bold text-white/70">
            Accepted: <span className="text-accent">{(q.correct as string[]).join(" / ")}</span>
          </p>
          {q.texts && q.texts.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {q.texts.map((t) => (
                <li
                  key={t.text}
                  className={`rounded-full px-3 py-1 text-sm font-extrabold ${t.is_correct ? "bg-[#06a77d]" : "bg-white/15"}`}
                >
                  {t.text} {t.count > 1 && <span className="opacity-70">×{t.count}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm font-semibold text-white/50">No answers yet</p>
          )}
        </div>
      ) : (
        <ul className="mt-3 grid gap-2">
          {q.options.map((opt, i) => {
            const st = OPTION_STYLES[i];
            const n = q.counts?.[i] ?? 0;
            const right = correctSet.has(i);
            return (
              <li key={i} className="flex items-center gap-3">
                <span
                  className="font-display grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold"
                  style={{ background: st.bg }}
                  aria-hidden
                >
                  {st.letter}
                </span>
                <div className="relative h-9 min-w-0 flex-1 overflow-hidden rounded-lg bg-black/25">
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-lg"
                    style={{ background: st.bg, opacity: right || q.type === "poll" ? 1 : 0.55 }}
                    initial={{ width: 0 }}
                    animate={{ width: `${(n / max) * 100}%` }}
                    transition={{ type: "spring", stiffness: 120, damping: 20 }}
                  />
                  <span className="absolute inset-0 flex items-center px-3 text-sm font-extrabold">
                    <span className="truncate">{opt}</span>
                    {right && <span className="ml-2">✓</span>}
                  </span>
                </div>
                <span className="font-display w-8 text-right text-lg font-bold">{n}</span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
