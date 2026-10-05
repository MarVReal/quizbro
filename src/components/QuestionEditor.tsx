"use client";

import { motion } from "framer-motion";
import { OPTION_STYLES } from "@/lib/theme";
import { QUESTION_TYPES, isUnscored, type DraftQuestion } from "@/lib/types";
import { POINT_CHOICES, TIME_CHOICES, changeType } from "@/lib/draft";
import { MAX_ANSWERS, MAX_CHARS, clampInt } from "@/lib/multi-answer";

interface Props {
  q: DraftQuestion;
  onChange: (q: DraftQuestion) => void;
}

function Chip({
  active,
  onClick,
  children,
  label,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
      className={`rounded-full border-2 px-3 py-1.5 text-sm font-extrabold transition ${
        active
          ? "border-accent bg-accent text-accent-ink"
          : "border-white/20 bg-white/5 hover:bg-white/15"
      }`}
    >
      {children}
    </button>
  );
}

/** −/+ buttons around a number box. Typing commits on blur/Enter; the box remounts when the value changes. */
function NumberStepper({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  const commit = (n: number) => onChange(clampInt(n, min, max));
  const btn =
    "grid h-10 w-10 shrink-0 place-items-center rounded-xl border-2 border-white/20 bg-white/5 text-xl font-extrabold transition hover:bg-white/15 disabled:opacity-30";
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={btn}
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => commit(value - step)}
      >
        −
      </button>
      <input
        key={value}
        type="number"
        inputMode="numeric"
        className="field font-display w-20 text-center text-xl"
        aria-label={label}
        min={min}
        max={max}
        defaultValue={value}
        onBlur={(e) => commit(e.target.valueAsNumber)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <button
        type="button"
        className={btn}
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => commit(value + step)}
      >
        +
      </button>
    </div>
  );
}

export function QuestionEditor({ q, onChange }: Props) {
  const set = (patch: Partial<DraftQuestion>) => onChange({ ...q, ...patch });
  const isChoice = q.type !== "short_text" && q.type !== "multi_answer";
  const fixedOptions = q.type === "true_false";

  function toggleCorrect(i: number) {
    if (q.type === "multiple_select") {
      const has = q.correct.includes(i);
      set({ correct: has ? q.correct.filter((c) => c !== i) : [...q.correct, i].sort() });
    } else {
      set({ correct: [i] });
    }
  }

  function removeOption(i: number) {
    set({
      options: q.options.filter((_, idx) => idx !== i),
      correct: q.correct.filter((c) => c !== i).map((c) => (c > i ? c - 1 : c)),
    });
  }

  return (
    <div className="grid gap-5">
      <div>
        <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">
          Answer type
        </p>
        <div className="flex flex-wrap gap-2">
          {QUESTION_TYPES.map((t) => (
            <Chip
              key={t.id}
              active={q.type === t.id}
              onClick={() => onChange(changeType(q, t.id))}
            >
              {t.emoji} {t.label}
            </Chip>
          ))}
        </div>
        <p className="mt-2 text-sm font-semibold text-white/60">
          {QUESTION_TYPES.find((t) => t.id === q.type)?.hint}
        </p>
      </div>

      <div>
        <label htmlFor={`prompt-${q.uid}`} className="mb-2 block text-xs font-extrabold uppercase tracking-wider text-white/60">
          Question
        </label>
        <textarea
          id={`prompt-${q.uid}`}
          className="field font-display min-h-[5.5rem] resize-y text-xl"
          placeholder="What's the capital of Australia?"
          maxLength={300}
          value={q.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
        />
        <input
          className="field mt-2 text-sm"
          placeholder="Image link (optional): https://…"
          aria-label="Image link"
          value={q.image_url}
          onChange={(e) => set({ image_url: e.target.value })}
        />
      </div>

      {isChoice && (
        <div>
          <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">
            {q.type === "poll"
              ? "Options"
              : q.type === "multiple_select"
                ? "Options (tick every correct one)"
                : "Options (tick the correct one)"}
          </p>
          <ul className="grid gap-2">
            {q.options.map((opt, i) => {
              const style = OPTION_STYLES[i];
              const correct = q.correct.includes(i);
              return (
                <motion.li layout key={i} className="flex items-center gap-2">
                  <span
                    className="font-display grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg font-bold"
                    style={{ background: style.bg, boxShadow: `0 3px 0 ${style.shadow}` }}
                    aria-hidden
                  >
                    {style.letter}
                  </span>
                  <input
                    className="field"
                    placeholder={`Option ${style.letter}`}
                    aria-label={`Option ${style.letter}`}
                    maxLength={120}
                    value={opt}
                    readOnly={fixedOptions}
                    onChange={(e) =>
                      set({ options: q.options.map((o, idx) => (idx === i ? e.target.value : o)) })
                    }
                  />
                  {!isUnscored(q.type) && (
                    <button
                      type="button"
                      role={q.type === "multiple_select" ? "checkbox" : "radio"}
                      aria-checked={correct}
                      aria-label={`Mark option ${style.letter} as correct`}
                      onClick={() => toggleCorrect(i)}
                      className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border-2 text-lg transition ${
                        correct
                          ? "border-[#4be3a6] bg-[#06a77d] text-white"
                          : "border-white/25 bg-white/5 text-white/40 hover:bg-white/15"
                      }`}
                    >
                      ✓
                    </button>
                  )}
                  {!fixedOptions && (
                    <button
                      type="button"
                      aria-label={`Remove option ${style.letter}`}
                      disabled={q.options.length <= 2}
                      onClick={() => removeOption(i)}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white/60 hover:bg-white/15 disabled:opacity-30"
                    >
                      ✕
                    </button>
                  )}
                </motion.li>
              );
            })}
          </ul>
          {!fixedOptions && q.options.length < 6 && (
            <button
              type="button"
              onClick={() => set({ options: [...q.options, ""] })}
              className="btn btn-ghost mt-2 px-3 py-2 text-sm"
            >
              + Add option
            </button>
          )}
        </div>
      )}

      {q.type === "multi_answer" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">
              Max answers per person
            </p>
            <NumberStepper
              label="max answers per person"
              value={q.max_answers}
              min={MAX_ANSWERS.min}
              max={MAX_ANSWERS.max}
              onChange={(n) => set({ max_answers: n })}
            />
          </div>
          <div>
            <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">
              Max characters per answer
            </p>
            <NumberStepper
              label="max characters per answer"
              value={q.max_chars}
              min={MAX_CHARS.min}
              max={MAX_CHARS.max}
              step={5}
              onChange={(n) => set({ max_chars: n })}
            />
          </div>
          <p className="text-sm font-semibold text-white/60 sm:col-span-2">
            Players type up to {q.max_answers} answer{q.max_answers === 1 ? "" : "s"} each. Matching answers
            (ignoring capitals and extra spaces) merge into one bubble that grows with every vote.
          </p>
        </div>
      )}

      {q.type === "short_text" && (
        <div>
          <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">
            Accepted answers (not case sensitive)
          </p>
          <ul className="grid gap-2">
            {q.accepted.map((a, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  className="field"
                  placeholder={i === 0 ? "Canberra" : "Another accepted spelling"}
                  aria-label={`Accepted answer ${i + 1}`}
                  maxLength={200}
                  value={a}
                  onChange={(e) =>
                    set({ accepted: q.accepted.map((x, idx) => (idx === i ? e.target.value : x)) })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove accepted answer ${i + 1}`}
                  disabled={q.accepted.length <= 1}
                  onClick={() => set({ accepted: q.accepted.filter((_, idx) => idx !== i) })}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white/60 hover:bg-white/15 disabled:opacity-30"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {q.accepted.length < 10 && (
            <button
              type="button"
              onClick={() => set({ accepted: [...q.accepted, ""] })}
              className="btn btn-ghost mt-2 px-3 py-2 text-sm"
            >
              + Add accepted answer
            </button>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">
            ⏱ Timer
          </p>
          <div className="flex flex-wrap gap-2">
            {TIME_CHOICES.map((t) => (
              <Chip key={t} active={q.time_limit === t} onClick={() => set({ time_limit: t })}>
                {t}s
              </Chip>
            ))}
          </div>
        </div>
        {!isUnscored(q.type) && (
          <div>
            <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-white/60">
              ⭐ Max points (faster = more)
            </p>
            <div className="flex flex-wrap gap-2">
              {POINT_CHOICES.map((p) => (
                <Chip key={p} active={q.points === p} onClick={() => set({ points: p })}>
                  {p}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
