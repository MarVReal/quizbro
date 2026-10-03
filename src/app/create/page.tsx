"use client";

import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Confirm, ErrorBox, Logo, Page } from "@/components/ui";
import { QuestionEditor } from "@/components/QuestionEditor";
import { createQuiz, newHostToken } from "@/lib/api";
import { blankQuestion, draftProblem, questionProblem, type Draft } from "@/lib/draft";
import { clearDraft, getDraft, saveDraft, saveMyQuiz } from "@/lib/storage";
import { THEMES } from "@/lib/theme";
import { QUESTION_TYPES, type DraftQuestion, type QuestionType } from "@/lib/types";

const emptyDraft = (): Draft => ({
  title: "",
  description: "",
  theme: "grape",
  questions: [blankQuestion("multiple_choice")],
});

export default function CreatePage() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  // null = "first question open"; "" = everything collapsed.
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const loaded = useRef(false);

  // Restore an unfinished draft (browser-only storage, so it has to run after mount).
  useEffect(() => {
    const saved = getDraft<Draft>();
    if (saved && saved.questions?.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(saved);
      setActive(saved.questions[0].uid);
      setRestored(true);
    }
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => saveDraft(draft), 400);
    return () => clearTimeout(t);
  }, [draft]);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const updateQ = (q: DraftQuestion) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((x) => (x.uid === q.uid ? q : x)) }));

  function addQuestion(type: QuestionType) {
    const q = blankQuestion(type);
    setDraft((d) => ({ ...d, questions: [...d.questions, q] }));
    setActive(q.uid);
    setError(null);
  }

  function move(i: number, dir: -1 | 1) {
    setDraft((d) => {
      const qs = [...d.questions];
      const j = i + dir;
      if (j < 0 || j >= qs.length) return d;
      [qs[i], qs[j]] = [qs[j], qs[i]];
      return { ...d, questions: qs };
    });
  }

  function duplicate(i: number) {
    const copy = { ...draft.questions[i], uid: crypto.randomUUID() };
    setDraft((d) => {
      const qs = [...d.questions];
      qs.splice(i + 1, 0, copy);
      return { ...d, questions: qs };
    });
    setActive(copy.uid);
  }

  function remove(i: number) {
    setDraft((d) => ({ ...d, questions: d.questions.filter((_, idx) => idx !== i) }));
  }

  async function publish() {
    const problem = draftProblem(draft);
    if (problem) {
      setError(problem);
      const bad = draft.questions.find((q) => questionProblem(q));
      if (bad && draft.title.trim()) setActive(bad.uid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const hostToken = newHostToken();
      const { id, code } = await createQuiz({
        title: draft.title,
        description: draft.description,
        theme: draft.theme,
        hostToken,
        questions: draft.questions,
      });
      saveMyQuiz({ id, code, title: draft.title.trim(), hostToken, createdAt: Date.now() });
      clearDraft();
      router.push(`/share/${id}#t=${hostToken}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  const totalSeconds = draft.questions.reduce((s, q) => s + q.time_limit, 0);

  return (
    <Page theme={draft.theme}>
      <div className="mx-auto max-w-3xl px-4 pb-40 pt-6">
        <header className="mb-6 flex items-center justify-between">
          <Logo small />
          <Confirm
            label="Really start over?"
            className="text-sm font-bold text-white/60 hover:text-white"
            onConfirm={() => {
              clearDraft();
              const d = emptyDraft();
              setDraft(d);
              setActive(null);
              setRestored(false);
            }}
          >
            Start over
          </Confirm>
        </header>

        <h1 className="font-display text-4xl font-bold">Build your quiz</h1>
        {restored && (
          <p className="mt-1 text-sm font-semibold text-white/60">Picked up where you left off.</p>
        )}

        <section className="card mt-6 grid gap-4 p-5">
          <div>
            <label htmlFor="title" className="mb-2 block text-xs font-extrabold uppercase tracking-wider text-white/60">
              Quiz title
            </label>
            <input
              id="title"
              className="field font-display text-2xl"
              placeholder="Friday Night Trivia"
              maxLength={120}
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="desc" className="mb-2 block text-xs font-extrabold uppercase tracking-wider text-white/60">
              Short description (optional)
            </label>
            <input
              id="desc"
              className="field"
              placeholder="Ten questions to settle who's the smartest bro"
              maxLength={500}
              value={draft.description}
              onChange={(e) => update({ description: e.target.value })}
            />
          </div>
          <div>
            <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">Look &amp; feel</p>
            <div className="flex flex-wrap gap-3">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={draft.theme === t.id}
                  onClick={() => update({ theme: t.id })}
                  className={`flex items-center gap-2 rounded-full border-2 py-1.5 pl-1.5 pr-3.5 text-sm font-extrabold transition ${
                    draft.theme === t.id ? "border-accent bg-white/15" : "border-white/15 hover:bg-white/10"
                  }`}
                >
                  <span className="h-7 w-7 rounded-full" style={{ background: t.swatch }} />
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <ol className="mt-6 grid gap-3">
          <AnimatePresence initial={false}>
            {draft.questions.map((q, i) => {
              const open = (active ?? draft.questions[0]?.uid) === q.uid;
              const problem = questionProblem(q);
              const meta = QUESTION_TYPES.find((t) => t.id === q.type)!;
              return (
                <motion.li
                  layout
                  key={q.uid}
                  initial={{ opacity: 0, y: 16, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  className={`card overflow-hidden ${open ? "ring-2 ring-accent" : ""}`}
                >
                  <div className="flex items-center gap-2 p-3">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setActive(open ? "" : q.uid)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left"
                    >
                      <span className="font-display grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-lg font-bold text-accent-ink">
                        {i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="font-display block truncate text-lg font-semibold">
                          {q.prompt.trim() || "Untitled question"}
                        </span>
                        <span className="block text-xs font-bold text-white/60">
                          {meta.emoji} {meta.label} · {q.time_limit}s
                          {q.type !== "poll" && ` · ${q.points} pts`}
                          {problem && !open && <span className="ml-2 text-[#ffb3be]">⚠ {problem}</span>}
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center">
                      <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</IconBtn>
                      <IconBtn label="Move down" disabled={i === draft.questions.length - 1} onClick={() => move(i, 1)}>↓</IconBtn>
                      <IconBtn label="Duplicate question" onClick={() => duplicate(i)}>⧉</IconBtn>
                      <IconBtn label="Delete question" disabled={draft.questions.length === 1} onClick={() => remove(i)}>🗑</IconBtn>
                    </div>
                  </div>
                  {open && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="border-t border-white/15 p-4 sm:p-5"
                    >
                      <QuestionEditor q={q} onChange={updateQ} />
                    </motion.div>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>

        <section className="mt-5">
          <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">Add a question</p>
          <div className="flex flex-wrap gap-2">
            {QUESTION_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => addQuestion(t.id)}
                disabled={draft.questions.length >= 50}
                className="btn btn-ghost px-3.5 py-2 text-sm"
              >
                {t.emoji} {t.label}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-white/15 bg-black/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-3">
          {error && <ErrorBox>{error}</ErrorBox>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold text-white/70">
              {draft.questions.length} question{draft.questions.length === 1 ? "" : "s"} · ~
              {Math.max(1, Math.round(totalSeconds / 60))} min
            </p>
            <button className="btn btn-primary px-6 py-3 text-lg" onClick={publish} disabled={busy}>
              {busy ? "Publishing…" : "Publish & get QR codes 🚀"}
            </button>
          </div>
        </div>
      </div>
    </Page>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-lg text-base text-white/70 transition hover:bg-white/15 disabled:opacity-25"
    >
      {children}
    </button>
  );
}
