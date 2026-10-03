"use client";

import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { use, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AnimatedNumber, ErrorBox, Logo, Page, Spinner } from "@/components/ui";
import { hostDashboard } from "@/lib/api";
import { getMyQuizzes, saveMyQuiz } from "@/lib/storage";
import { OPTION_STYLES, asTheme } from "@/lib/theme";
import { QUESTION_TYPES, type HostDashboard, type HostQuestion } from "@/lib/types";

const POLL_MS = 2000;

function tokenFromHash(): string {
  const m = window.location.hash.match(/[#&]t=([a-f0-9]+)/i);
  return m ? m[1] : "";
}

export default function HostPage({ params }: PageProps<"/host/[id]">) {
  const { id } = use(params);
  const [data, setData] = useState<HostDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState(false);
  const [tab, setTab] = useState<"players" | "questions">("players");
  const [showJoin, setShowJoin] = useState(false);
  const [updated, setUpdated] = useState<number>(0);
  const [now, setNow] = useState<number>(0);
  const [token, setToken] = useState("");

  useEffect(() => {
    const hostToken = tokenFromHash() || getMyQuizzes().find((q) => q.id === id)?.hostToken || "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(hostToken);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;

    async function tick() {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      try {
        const d = await hostDashboard(id, hostToken);
        if (stopped) return;
        setData(d);
        setError(null);
        setUpdated(Date.now());
        if (first) {
          first = false;
          saveMyQuiz({ id, code: d.quiz.code, title: d.quiz.title, hostToken, createdAt: Date.now() });
        }
      } catch (e) {
        if (stopped) return;
        const msg = e instanceof Error ? e.message : "Connection problem";
        if (first && msg.includes("Invalid host link")) {
          setFatal(true);
          setError(msg);
          return;
        }
        setError(msg);
      }
      timer = setTimeout(tick, POLL_MS);
    }
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  // One-second ticker so the LIVE badge and "answering now" dots stay honest.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const stats = useMemo(() => {
    if (!data) return null;
    const answers = data.questions.reduce((s, q) => s + q.answered, 0);
    const finished = data.players.filter((p) => p.answered >= data.question_count && data.question_count > 0).length;
    const scored = data.questions.filter((q) => q.type !== "poll" && q.answered > 0);
    const hardest = scored.length
      ? scored.reduce((a, b) => (b.right / b.answered < a.right / a.answered ? b : a))
      : null;
    return { answers, finished, hardest };
  }, [data]);

  if (fatal) {
    return (
      <Page>
        <div className="mx-auto max-w-md px-5 pt-16 text-center">
          <Logo />
          <div className="mt-8">
            <ErrorBox>This host link isn&apos;t valid. Use the private QR or link from when you created the quiz.</ErrorBox>
          </div>
          <Link href="/" className="btn btn-primary mt-6">Back home</Link>
        </div>
      </Page>
    );
  }
  if (!data || !stats) {
    return (
      <Page>
        <Spinner />
      </Page>
    );
  }

  const origin = window.location.origin;
  const playUrl = `${origin}/play/${data.quiz.code}`;
  const live = now - updated < POLL_MS * 3 && !error;

  function exportCsv() {
    if (!data) return;
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [
      ["Rank", "Name", "Score", "Answered", "Correct"],
      ...data.players.map((p, i) => [i + 1, p.name, p.score, p.answered, p.correct]),
    ];
    const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `quizbro-${data.quiz.code}-results.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Page theme={asTheme(data.quiz.theme)}>
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-5">
        <header className="mb-5 flex items-center justify-between gap-3">
          <Logo small />
          <span
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-extrabold ${live ? "bg-[#06a77d]" : "bg-[#ef476f]"}`}
            role="status"
          >
            <span className={`h-2 w-2 rounded-full bg-white ${live ? "animate-pulse" : ""}`} />
            {live ? "LIVE" : "RECONNECTING…"}
          </span>
        </header>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display truncate text-3xl font-bold sm:text-4xl">{data.quiz.title}</h1>
            <p className="font-semibold text-white/70">
              Join code <span className="font-display font-bold tracking-widest text-accent">{data.quiz.code}</span>
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary px-4 py-2 text-sm" onClick={() => setShowJoin(true)}>
              Show join QR
            </button>
            <Link href={`/share/${id}#t=${token}`} className="btn btn-ghost px-4 py-2 text-sm">
              Share
            </Link>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Players" value={data.players.length} emoji="👥" />
          <Tile label="Finished" value={stats.finished} emoji="🏁" />
          <Tile label="Answers" value={stats.answers} emoji="✍️" />
          <Tile
            label="Hardest"
            emoji="🔥"
            text={stats.hardest ? `Q${stats.hardest.pos} · ${Math.round((stats.hardest.right / stats.hardest.answered) * 100)}%` : "—"}
          />
        </div>

        {error && <div className="mt-4"><ErrorBox>{error}</ErrorBox></div>}

        <div className="mt-6 flex items-center justify-between gap-3">
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
          <button className="text-sm font-bold text-white/70 hover:text-white" onClick={exportCsv} disabled={data.players.length === 0}>
            ⬇ CSV
          </button>
        </div>

        <div className="mt-4">
          {tab === "players" ? (
            <Leaderboard data={data} now={now} />
          ) : (
            <ul className="grid gap-4">
              {data.questions.map((q) => (
                <QuestionCard key={q.id} q={q} players={data.players.length} />
              ))}
            </ul>
          )}
        </div>
      </main>

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
                <QRCodeSVG value={playUrl} size={Math.min(420, window.innerWidth - 100)} marginSize={0} fgColor="#1a0b36" />
              </div>
              <p className="mt-6 text-xl font-bold text-white/80">Scan to play, or enter code</p>
              <p className="font-display text-7xl font-bold tracking-[0.25em] text-accent">{data.quiz.code}</p>
              <p className="mt-6 text-sm font-semibold text-white/60">Tap anywhere to close</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Page>
  );
}

function Tile({ label, value, text, emoji }: { label: string; value?: number; text?: string; emoji: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-extrabold uppercase tracking-wider text-white/60">
        {emoji} {label}
      </p>
      <p className="font-display mt-1 text-3xl font-bold">
        {value !== undefined ? <AnimatedNumber value={value} /> : text}
      </p>
    </div>
  );
}

function Leaderboard({ data, now }: { data: HostDashboard; now: number }) {
  if (data.players.length === 0) {
    return (
      <div className="card p-10 text-center">
        <p className="text-5xl">📱</p>
        <p className="font-display mt-3 text-2xl font-semibold">Waiting for players…</p>
        <p className="mt-1 font-semibold text-white/70">
          Players appear here the moment they scan the QR code and join.
        </p>
      </div>
    );
  }
  const top = Math.max(1, ...data.players.map((p) => p.score));
  return (
    <ol className="grid gap-2">
      {data.players.map((p, i) => {
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
              <span className="font-display w-9 text-center text-xl font-bold">
                {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-lg font-extrabold">
                  {p.name}
                  {active && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#4be3a6]" title="Answering now" />}
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
