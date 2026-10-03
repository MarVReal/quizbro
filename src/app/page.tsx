"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Logo, Page, Confirm } from "@/components/ui";
import { forgetMyQuiz, getMyQuizzes, type MyQuiz } from "@/lib/storage";

const FLOATERS = [
  { e: "🎯", x: "6%", y: "18%", r: "-12deg", d: "0s" },
  { e: "🏆", x: "88%", y: "14%", r: "10deg", d: "0.8s" },
  { e: "⚡", x: "12%", y: "72%", r: "8deg", d: "1.6s" },
  { e: "🎉", x: "84%", y: "70%", r: "-8deg", d: "0.4s" },
  { e: "🧠", x: "48%", y: "6%", r: "6deg", d: "2s" },
];

const STEPS = [
  { n: "1", t: "Build it", d: "Add questions, pick answer types, set timers and points." },
  { n: "2", t: "Share the QR", d: "Players scan and join from their phones. No app, no sign-up." },
  { n: "3", t: "Watch live", d: "A private host QR opens your dashboard with answers rolling in." },
];

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [mine, setMine] = useState<MyQuiz[]>([]);

  useEffect(() => {
    // localStorage only exists in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMine(getMyQuizzes());
  }, []);

  function join(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c) router.push(`/play/${c}`);
  }

  return (
    <Page className="relative overflow-hidden">
      {FLOATERS.map((f) => (
        <span
          key={f.e}
          aria-hidden
          className="float pointer-events-none absolute hidden select-none text-5xl opacity-60 sm:block"
          style={{ left: f.x, top: f.y, ["--r" as string]: f.r, animationDelay: f.d }}
        >
          {f.e}
        </span>
      ))}

      <main className="relative mx-auto flex max-w-3xl flex-col items-center px-5 pb-20 pt-8 text-center">
        <header className="mb-10 flex w-full items-center justify-between">
          <Logo />
          <a
            href="https://github.com/MarVReal/quizbro"
            className="text-sm font-bold text-white/70 hover:text-white"
          >
            Open source ↗
          </a>
        </header>

        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          className="font-display text-5xl font-bold leading-[1.05] sm:text-7xl"
        >
          Make a quiz.
          <br />
          <span className="text-accent">Scan. Play.</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.15 }}
          className="mt-5 max-w-xl text-lg font-semibold text-white/80"
        >
          Build a timed quiz in minutes. Everyone joins from their phone with a QR code, and you
          get a private QR to watch every answer land, live.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="mt-9 grid w-full gap-4 sm:grid-cols-2"
        >
          <form onSubmit={join} className="card flex flex-col gap-3 p-5 text-left">
            <label htmlFor="code" className="font-display text-xl font-semibold">
              Got a code?
            </label>
            <input
              id="code"
              className="field font-display text-center text-3xl uppercase tracking-[0.3em]"
              placeholder="ABC123"
              maxLength={6}
              autoComplete="off"
              autoCapitalize="characters"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <button className="btn btn-primary" disabled={code.trim().length < 4}>
              Join quiz →
            </button>
          </form>

          <div className="card flex flex-col justify-between gap-3 p-5 text-left">
            <div>
              <h2 className="font-display text-xl font-semibold">Want to host?</h2>
              <p className="mt-1 font-semibold text-white/75">
                Multiple choice, select-all, true/false, typed answers and polls, each with its own
                timer.
              </p>
            </div>
            <Link href="/create" className="btn btn-primary">
              Create a quiz ✨
            </Link>
          </div>
        </motion.div>

        {mine.length > 0 && (
          <section className="mt-10 w-full text-left">
            <h2 className="font-display mb-3 text-xl font-semibold">Your quizzes</h2>
            <ul className="grid gap-3">
              {mine.map((q) => (
                <li key={q.id} className="card flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="font-display truncate text-lg font-semibold">{q.title}</p>
                    <p className="text-sm font-bold text-white/60">Code {q.code}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Link
                      href={`/share/${q.id}#t=${q.hostToken}`}
                      className="btn btn-ghost px-3 py-2 text-sm"
                    >
                      QR codes
                    </Link>
                    <Link
                      href={`/host/${q.id}#t=${q.hostToken}`}
                      className="btn btn-primary px-3 py-2 text-sm"
                    >
                      Live results
                    </Link>
                    <Confirm
                      label="Sure?"
                      className="btn btn-ghost px-3 py-2 text-sm"
                      onConfirm={() => {
                        forgetMyQuiz(q.id);
                        setMine(getMyQuizzes());
                      }}
                    >
                      ✕
                    </Confirm>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs font-semibold text-white/50">
              Saved in this browser only. Removing one here doesn&apos;t delete the quiz.
            </p>
          </section>
        )}

        <section className="mt-14 grid w-full gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="card p-5 text-left"
            >
              <span className="font-display grid h-9 w-9 place-items-center rounded-full bg-accent text-lg font-bold text-accent-ink">
                {s.n}
              </span>
              <h3 className="font-display mt-3 text-xl font-semibold">{s.t}</h3>
              <p className="mt-1 text-sm font-semibold text-white/75">{s.d}</p>
            </motion.div>
          ))}
        </section>
      </main>
    </Page>
  );
}
