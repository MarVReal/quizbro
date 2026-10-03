"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ErrorBox, Logo, Page, Spinner } from "@/components/ui";
import { QRCard } from "@/components/QRCard";
import { hostDashboard } from "@/lib/api";
import { bigConfetti } from "@/lib/fx";
import { getMyQuizzes, saveMyQuiz } from "@/lib/storage";
import { asTheme } from "@/lib/theme";
import type { HostDashboard } from "@/lib/types";

function tokenFromHash(): string {
  const m = window.location.hash.match(/[#&]t=([a-f0-9]+)/i);
  return m ? m[1] : "";
}

export default function SharePage({ params }: PageProps<"/share/[id]">) {
  const { id } = use(params);
  const [data, setData] = useState<HostDashboard | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Fall back to the token saved in this browser when the link has no #t=…
    const t = tokenFromHash() || getMyQuizzes().find((q) => q.id === id)?.hostToken || "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(t);
    hostDashboard(id, t)
      .then((d) => {
        setData(d);
        saveMyQuiz({ id, code: d.quiz.code, title: d.quiz.title, hostToken: t, createdAt: Date.now() });
        bigConfetti();
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  if (error) {
    return (
      <Page>
        <div className="mx-auto max-w-md px-5 pt-16 text-center">
          <Logo />
          <div className="mt-8">
            <ErrorBox>{error}. This page needs the private host link that was shown when the quiz was created.</ErrorBox>
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

  const code = data.quiz.code;
  const playUrl = `${origin}/play/${code}`;
  const hostUrl = `${origin}/host/${id}#t=${token}`;

  return (
    <Page theme={asTheme(data.quiz.theme)}>
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-6">
        <header className="no-print mb-6 flex items-center justify-between">
          <Logo small />
          <Link href="/" className="text-sm font-bold text-white/70 hover:text-white">Home</Link>
        </header>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="text-center">
          <p className="text-5xl">🎉</p>
          <h1 className="font-display mt-2 text-4xl font-bold sm:text-5xl">Your quiz is live!</h1>
          <p className="mt-2 text-lg font-semibold text-white/80">
            {data.quiz.title} · {data.question_count} question{data.question_count === 1 ? "" : "s"}
          </p>
        </motion.div>

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <QRCard title="Players scan this" badge="For players" url={playUrl} filename={`quizbro-${code}-join`}>
              <div>
                <p className="text-sm font-bold text-white/70">or enter the code</p>
                <p className="font-display text-5xl font-bold tracking-[0.25em] text-accent">{code}</p>
                <p className="mt-1 break-all text-xs font-semibold text-white/50">{playUrl}</p>
              </div>
            </QRCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <QRCard title="Your answers dashboard" badge="Private · host only" url={hostUrl} filename={`quizbro-${code}-host`} tone="host">
              <p className="max-w-xs text-sm font-semibold text-white/75">
                Scan on your own phone to watch answers and the leaderboard update live. Anyone with
                this link can see the answers, so don&apos;t put it on the big screen.
              </p>
            </QRCard>
          </motion.div>
        </div>

        <div className="no-print mt-8 flex flex-wrap justify-center gap-3">
          <Link href={`/host/${id}#t=${token}`} className="btn btn-primary text-lg">
            Open live dashboard →
          </Link>
          <Link href={`/play/${code}`} className="btn btn-ghost">Try it as a player</Link>
          <button onClick={() => window.print()} className="btn btn-ghost">Print QR codes</button>
        </div>
      </main>
    </Page>
  );
}
