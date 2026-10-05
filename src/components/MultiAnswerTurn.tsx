"use client";

import { useGSAP } from "@gsap/react";
import { useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useEffect, useRef, useState } from "react";
import { ANSWER_COOLDOWN_S, charCount, cleanAnswer, validateNextAnswer } from "@/lib/multi-answer";

gsap.registerPlugin(useGSAP);

const RING_R = 24;
const RING_C = 2 * Math.PI * RING_R;

/** A cooldown between answers. `ends` is a performance.now() timestamp; `key` changes whenever one starts. */
export interface Cooldown {
  key: number;
  ends: number;
}

interface Props {
  /** Answers this player has already sent. */
  sent: string[];
  maxAnswers: number;
  maxChars: number;
  draft: string;
  onDraft: (v: string) => void;
  cooldown: Cooldown;
  /** True while an answer is on its way to the server. */
  busy: boolean;
  /** Error from the server for the last send. */
  error: string | null;
  /** Called with a validated, trimmed answer. */
  onSend: (answer: string) => void;
}

/**
 * One answer at a time: type it, send it, wait out a short "reload" ring, send the next, until
 * the allowance is used. Typing is allowed during the cooldown; only sending waits.
 * GSAP drives the motion (entrance, cooldown ring, chip pop-in, error shake); with
 * prefers-reduced-motion everything is shown without animating.
 */
export function MultiAnswerTurn({
  sent,
  maxAnswers,
  maxChars,
  draft,
  onDraft,
  cooldown,
  busy,
  error,
  onSend,
}: Props) {
  const reduced = useReducedMotion() ?? false;
  const root = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<{ text: string; key: number } | null>(null);
  // Re-read ~10x/s while a cooldown runs. A stale value only ever overestimates the time left.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!cooldown.ends) return;
    const id = setInterval(() => {
      const now = performance.now();
      setTick(now);
      if (now >= cooldown.ends) clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, [cooldown.ends, cooldown.key]);

  const left = cooldown.ends > 0 ? Math.max(0, (cooldown.ends - tick) / 1000) : 0;
  const cooling = left > 0;
  const secs = Math.ceil(Math.min(left, ANSWER_COOLDOWN_S));
  const used = sent.length;
  const allUsed = used >= maxAnswers;
  const len = charCount(cleanAnswer(draft));
  const shownError = problem?.text ?? error;

  // Entrance.
  useGSAP(
    () => {
      if (reduced) return;
      gsap.from(".mat-enter", { opacity: 0, y: 14, duration: 0.45, stagger: 0.07, ease: "power2.out", clearProps: "all" });
    },
    { scope: root, dependencies: [reduced] },
  );

  // The "reload" ring drains over the cooldown, then the input gives a little pulse.
  useGSAP(
    () => {
      if (!cooldown.key || reduced) return;
      const ms = cooldown.ends - performance.now();
      if (ms <= 0) return;
      const secs = ms / 1000;
      gsap.fromTo(
        ".mat-ring",
        { strokeDashoffset: RING_C * (1 - Math.min(1, ms / (ANSWER_COOLDOWN_S * 1000))) },
        { strokeDashoffset: RING_C, duration: secs, ease: "none" },
      );
      // The ring fades in, and out again when the cooldown is over (GSAP owns its opacity).
      gsap
        .timeline()
        .fromTo(".mat-ring-wrap", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(2)" })
        .to(".mat-ring-wrap", { scale: 0.6, opacity: 0, duration: 0.25, ease: "power1.in" }, Math.max(0.35, secs));
      gsap.fromTo(".mat-input", { scale: 0.98 }, { scale: 1, duration: 0.4, delay: secs, ease: "back.out(4)" });
    },
    { scope: root, dependencies: [cooldown.key, reduced] },
  );

  // A new answer pops into the chip row.
  const prevUsed = useRef(used);
  useGSAP(
    () => {
      if (used > prevUsed.current && !reduced) {
        gsap.fromTo(
          ".mat-chip:last-child",
          { scale: 0.3, opacity: 0, y: -14 },
          { scale: 1, opacity: 1, y: 0, duration: 0.55, ease: "back.out(2.4)" },
        );
      }
      prevUsed.current = used;
    },
    { scope: root, dependencies: [used, reduced] },
  );

  // All answers used: celebrate.
  useGSAP(
    () => {
      if (allUsed && !reduced) {
        gsap.fromTo(".mat-done", { scale: 0.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: "back.out(2)" });
      }
    },
    { scope: root, dependencies: [allUsed, reduced] },
  );

  // Shake the input when something is wrong.
  useGSAP(
    () => {
      if (shownError && !reduced) {
        gsap.fromTo(".mat-input", { x: -10 }, { x: 0, duration: 0.55, ease: "elastic.out(1, 0.25)" });
      }
    },
    { scope: root, dependencies: [problem?.key, error, reduced] },
  );

  function submit() {
    if (busy || cooling) return;
    const check = validateNextAnswer(draft, sent, { maxAnswers, maxChars });
    if (!check.ok) {
      setProblem({ text: check.error, key: Date.now() });
      return;
    }
    setProblem(null);
    onSend(check.answer);
  }

  const answersLeft = maxAnswers - used;

  return (
    <div ref={root} className="grid gap-3">
      <div className="mat-enter flex items-center justify-between text-sm font-extrabold">
        <span className="text-white/70">
          {allUsed ? "All answers sent" : `Answer ${used + 1} of ${maxAnswers}`}
        </span>
        <span className="rounded-full bg-white/15 px-3 py-1">
          {answersLeft} left
        </span>
      </div>

      {used > 0 && (
        <ul className="mat-enter flex flex-wrap gap-2" aria-label="Your answers">
          {sent.map((a) => (
            <li key={a} className="mat-chip rounded-full bg-accent px-3 py-1 text-sm font-extrabold text-accent-ink">
              ✓ {a}
            </li>
          ))}
        </ul>
      )}

      {allUsed ? (
        <div className="mat-done card px-5 py-6 text-center">
          <p className="text-4xl" aria-hidden>
            🎉
          </p>
          <p className="font-display mt-1 text-2xl font-bold">All answers sent!</p>
          <p className="text-sm font-semibold text-white/75">Watch the bubbles grow while you wait.</p>
        </div>
      ) : (
        <form
          className="mat-enter grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex items-start gap-3">
            <div className="mat-input min-w-0 flex-1">
              <input
                className="field font-display text-xl"
                style={shownError ? { borderColor: "#ef476f" } : undefined}
                placeholder={cooling ? "Reloading… type your next one" : "Type an answer…"}
                aria-label="Your answer"
                aria-invalid={shownError ? true : undefined}
                autoComplete="off"
                enterKeyHint="send"
                autoFocus
                value={draft}
                onChange={(e) => {
                  setProblem(null);
                  onDraft(e.target.value);
                }}
              />
              <p
                className={`mt-1 px-1 text-right text-xs font-extrabold ${len > maxChars ? "text-[#ffb3be]" : "text-white/50"}`}
              >
                {len}/{maxChars}
              </p>
            </div>

            {/* The cooldown ring: always mounted so GSAP can drive it; invisible when idle. */}
            <div
              className="mat-ring-wrap relative h-14 w-14 shrink-0 opacity-0"
              style={reduced ? { opacity: cooling ? 1 : 0 } : undefined}
              aria-hidden={!cooling}
            >
              <svg viewBox="0 0 56 56" className="h-full w-full -rotate-90">
                <circle cx="28" cy="28" r={RING_R} fill="none" stroke="rgba(255,255,255,.2)" strokeWidth="5" />
                <circle
                  className="mat-ring"
                  cx="28"
                  cy="28"
                  r={RING_R}
                  fill="none"
                  stroke="var(--accent, #ffd23f)"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C}
                />
              </svg>
              <span className="font-display absolute inset-0 grid place-items-center text-xl font-bold">{cooling ? secs : ""}</span>
            </div>
          </div>

          {shownError && (
            <p role="alert" className="text-sm font-extrabold text-[#ffb3be]">
              {shownError}
            </p>
          )}

          <button className="btn btn-primary py-4 text-xl" disabled={busy || cooling || cleanAnswer(draft) === ""}>
            {busy ? "Sending…" : cooling ? `Next answer in ${secs}s` : "Send answer 🚀"}
          </button>
        </form>
      )}
    </div>
  );
}
