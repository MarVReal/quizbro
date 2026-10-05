"use client";

import { useGSAP } from "@gsap/react";
import { useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useEffect, useRef, useState } from "react";
import { ANSWER_COOLDOWN_S, charCount, cleanAnswer, validateNextAnswer } from "@/lib/multi-answer";

gsap.registerPlugin(useGSAP);

const RING_R = 21;
const RING_C = 2 * Math.PI * RING_R;

/** A short wait between sends. `ends` is a performance.now() timestamp; `key` changes whenever one starts. */
export interface Cooldown {
  key: number;
  ends: number;
}

interface Props {
  /** Answers this player has already sent (used for the "N left" count and duplicate check). */
  sent: string[];
  maxAnswers: number;
  maxChars: number;
  draft: string;
  onDraft: (v: string) => void;
  cooldown: Cooldown;
  /** True while a message is on its way to the server. */
  busy: boolean;
  /** Error from the server for the last send. */
  error: string | null;
  /** Called with a validated, trimmed answer. */
  onSend: (answer: string) => void;
  className?: string;
}

/**
 * A chat box. Type, press send (or Enter): the text disappears into the live chat and the box is
 * ready for the next one, until the allowance is used up. A tiny ring around the send button
 * shows the short wait between messages; you can keep typing during it.
 */
export function ChatComposer({
  sent,
  maxAnswers,
  maxChars,
  draft,
  onDraft,
  cooldown,
  busy,
  error,
  onSend,
  className = "",
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
  const answersLeft = maxAnswers - used;
  const allUsed = answersLeft <= 0;
  const len = charCount(cleanAnswer(draft));
  const shownError = problem?.text ?? error;
  const canSend = !busy && !cooling && cleanAnswer(draft) !== "";

  // The bar slides up when it first appears.
  useGSAP(
    () => {
      if (reduced) return;
      gsap.from(".cc-bar", { y: 30, opacity: 0, duration: 0.5, ease: "power3.out", clearProps: "all" });
    },
    { scope: root, dependencies: [reduced] },
  );

  // The ring drains over the cooldown; the send button pops when it is ready again.
  useGSAP(
    () => {
      if (!cooldown.key || reduced) return;
      const ms = cooldown.ends - performance.now();
      if (ms <= 0) return;
      const secs = ms / 1000;
      gsap.fromTo(
        ".cc-ring",
        { strokeDashoffset: RING_C * (1 - Math.min(1, ms / (ANSWER_COOLDOWN_S * 1000))) },
        { strokeDashoffset: RING_C, duration: secs, ease: "none" },
      );
      gsap.fromTo(".cc-send", { scale: 0.85 }, { scale: 1, duration: 0.4, delay: secs, ease: "back.out(4)" });
    },
    { scope: root, dependencies: [cooldown.key, reduced] },
  );

  // Sending: the box gives a little squash, like a message leaving.
  const prevUsed = useRef(used);
  useGSAP(
    () => {
      if (used > prevUsed.current && !reduced) {
        gsap.fromTo(".cc-pill", { scale: 0.96 }, { scale: 1, duration: 0.45, ease: "back.out(3)" });
      }
      prevUsed.current = used;
    },
    { scope: root, dependencies: [used, reduced] },
  );

  // Something is wrong: shake.
  useGSAP(
    () => {
      if (shownError && !reduced) {
        gsap.fromTo(".cc-pill", { x: -10 }, { x: 0, duration: 0.55, ease: "elastic.out(1, 0.25)" });
      }
    },
    { scope: root, dependencies: [problem?.key, error, reduced] },
  );

  // All used up.
  useGSAP(
    () => {
      if (allUsed && !reduced) {
        gsap.fromTo(".cc-done", { scale: 0.85, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.55, ease: "back.out(2)" });
      }
    },
    { scope: root, dependencies: [allUsed, reduced] },
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

  return (
    <div ref={root} className={className}>
      {allUsed ? (
        <div className="cc-done rounded-full bg-black/45 px-4 py-3 text-center text-sm font-extrabold backdrop-blur">
          🎉 You&apos;ve sent all your answers. Enjoy the show!
        </div>
      ) : (
        <form
          className="cc-bar grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {shownError && (
            <p role="alert" className="px-3 text-sm font-extrabold text-[#ffb3be]">
              {shownError}
            </p>
          )}
          <div className="cc-pill flex items-center gap-2 rounded-full bg-black/55 p-1.5 pl-4 backdrop-blur">
            <input
              className="min-w-0 flex-1 bg-transparent py-2 text-base font-bold text-white outline-none placeholder:text-white/50"
              placeholder={used === 0 ? "Type your answer…" : cooling ? "Type your next one…" : "Another answer…"}
              aria-label="Your answer"
              aria-invalid={shownError ? true : undefined}
              autoComplete="off"
              autoCapitalize="sentences"
              enterKeyHint="send"
              autoFocus
              value={draft}
              onChange={(e) => {
                setProblem(null);
                onDraft(e.target.value);
              }}
            />
            {len > 0 && (
              <span className={`shrink-0 text-xs font-extrabold ${len > maxChars ? "text-[#ffb3be]" : "text-white/50"}`}>
                {len}/{maxChars}
              </span>
            )}
            {/* The send button never steals focus, so the keyboard stays open for the next message. */}
            <button
              type="submit"
              aria-label={busy ? "Sending" : cooling ? `Wait ${secs} seconds` : "Send answer"}
              disabled={!canSend}
              onPointerDown={(e) => e.preventDefault()}
              className="cc-send relative grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent text-xl font-extrabold text-accent-ink transition disabled:opacity-45"
            >
              <svg viewBox="0 0 48 48" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
                <circle
                  className="cc-ring"
                  cx="24"
                  cy="24"
                  r={RING_R}
                  fill="none"
                  stroke="#2b1055"
                  strokeOpacity={cooling ? 0.55 : 0}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C}
                />
              </svg>
              <span className="relative">{busy ? "…" : cooling ? secs : "➤"}</span>
            </button>
          </div>
          <p className="px-3 text-xs font-extrabold text-white/60">
            {answersLeft} answer{answersLeft === 1 ? "" : "s"} left
            {cooling ? ` · next in ${secs}s` : ""}
          </p>
        </form>
      )}
    </div>
  );
}
