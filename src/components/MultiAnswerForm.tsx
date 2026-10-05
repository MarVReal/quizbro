"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { charCount, cleanAnswer, validateAnswers, type AnswerLimits } from "@/lib/multi-answer";

interface Props extends AnswerLimits {
  values: string[];
  onChange: (values: string[]) => void;
  /** Called with trimmed, validated answers only. */
  onSubmit: (answers: string[]) => void;
  /** True while a submit is in flight: inputs and buttons lock so it can't double-send. */
  busy: boolean;
}

export function MultiAnswerForm({ values, onChange, onSubmit, busy, maxAnswers, maxChars }: Props) {
  const [problem, setProblem] = useState<{ error: string; index?: number } | null>(null);
  const limits = { maxAnswers, maxChars };
  const filled = values.some((v) => cleanAnswer(v) !== "");

  function edit(next: string[]) {
    setProblem(null);
    onChange(next);
  }

  function submit() {
    const r = validateAnswers(values, limits);
    if (!r.ok) {
      setProblem({ error: r.error, index: r.index });
      return;
    }
    setProblem(null);
    onSubmit(r.answers);
  }

  function addBox() {
    if (values.length < maxAnswers) edit([...values, ""]);
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit();
      }}
    >
      <ul className="grid gap-2.5">
        <AnimatePresence initial={false}>
          {values.map((v, i) => {
            const len = charCount(cleanAnswer(v));
            const over = len > maxChars;
            const bad = problem?.index === i || over;
            return (
              <motion.li
                key={i}
                layout
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex items-start gap-2"
              >
                <div className="min-w-0 flex-1">
                  <input
                    className="field font-display text-xl"
                    style={bad ? { borderColor: "#ef476f" } : undefined}
                    placeholder={i === 0 ? "Type an answer…" : `Answer ${i + 1}`}
                    aria-label={`Answer ${i + 1}`}
                    aria-invalid={bad || undefined}
                    autoComplete="off"
                    autoFocus
                    enterKeyHint={i < maxAnswers - 1 ? "next" : "send"}
                    disabled={busy}
                    value={v}
                    onChange={(e) => edit(values.map((x, idx) => (idx === i ? e.target.value : x)))}
                    onKeyDown={(e) => {
                      // Enter on the last box with text opens the next one, like a quick-fire list.
                      if (e.key === "Enter" && i === values.length - 1 && values.length < maxAnswers && len > 0) {
                        e.preventDefault();
                        addBox();
                      }
                    }}
                  />
                  <p
                    className={`mt-1 px-1 text-right text-xs font-extrabold ${over ? "text-[#ffb3be]" : "text-white/50"}`}
                    aria-live="polite"
                  >
                    {len}/{maxChars}
                  </p>
                </div>
                {values.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove answer ${i + 1}`}
                    disabled={busy}
                    onClick={() => edit(values.filter((_, idx) => idx !== i))}
                    className="grid h-12 w-12 shrink-0 place-items-center rounded-xl text-white/70 hover:bg-white/15 disabled:opacity-30"
                  >
                    ✕
                  </button>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {problem && (
        <p role="alert" className="text-sm font-extrabold text-[#ffb3be]">
          {problem.error}
        </p>
      )}

      {values.length < maxAnswers && (
        <button type="button" className="btn btn-ghost py-2.5 text-base" disabled={busy} onClick={addBox}>
          + Add another answer ({values.length}/{maxAnswers})
        </button>
      )}

      <button className="btn btn-primary py-4 text-xl" disabled={busy || !filled}>
        {busy ? "Sending…" : "Lock in 🔒"}
      </button>
    </form>
  );
}
