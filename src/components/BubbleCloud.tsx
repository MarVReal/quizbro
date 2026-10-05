"use client";

import { motion, useReducedMotion } from "framer-motion";
import { memo, useMemo } from "react";
import { normalizeAnswer } from "@/lib/multi-answer";
import type { BubbleData } from "@/lib/types";
import { useBubblePhysics } from "@/lib/bubbles/useBubblePhysics";

// Same palette as the answer options, so bubbles feel like part of the app. `ink` keeps text readable.
const COLORS = [
  { bg: "#ef476f", ink: "#fff" },
  { bg: "#118ab2", ink: "#fff" },
  { bg: "#ffb703", ink: "#2a1458" },
  { bg: "#06a77d", ink: "#fff" },
  { bg: "#8d5bd6", ink: "#fff" },
  { bg: "#f77f00", ink: "#2a1458" },
] as const;

/** Font size that keeps the longest word on one line where possible (text width is ~78% of the diameter). */
function fontSizeFor(radius: number, text: string): number {
  const longest = Math.max(1, ...text.split(/\s+/).map((w) => [...w].length));
  const fit = (2.5 * radius) / longest;
  return Math.max(9, Math.min(56, radius * 0.38, fit));
}

/** Stable colour per answer, so a bubble keeps its colour across screens and refreshes. */
function colorFor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

interface Props {
  data: BubbleData | null | undefined;
  /** The viewer's own answers, to highlight their bubbles. */
  mine?: string[] | null;
  /** Size and position of the cloud (it needs `relative`/`absolute` plus a height); the bubbles fill that box. */
  className?: string;
  emptyText?: string;
}

function BubbleCloudImpl({ data, mine, className = "relative h-[24rem]", emptyText = "No answers yet" }: Props) {
  const reduced = useReducedMotion() ?? false;
  const animate = !reduced;
  const items = useMemo(() => data?.items ?? [], [data]);
  const { containerRef, view, register, bind, activeKey, clearTap, ready } = useBubblePhysics(items, animate);
  const mineKeys = useMemo(() => new Set((mine ?? []).map(normalizeAnswer)), [mine]);
  const active = activeKey ? items.find((i) => i.key === activeKey) : undefined;
  const more = data?.more ?? 0;

  return (
    <div
      ref={containerRef}
      className={`w-full touch-pan-y overflow-hidden rounded-2xl bg-black/20 ${className}`}
      role="group"
      aria-label="Answer bubbles"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) clearTap();
      }}
    >
      {items.length === 0 && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <div>
            <p className="text-5xl" aria-hidden>
              🫧
            </p>
            <p className="font-display mt-2 text-xl font-semibold text-white/80">{emptyText}</p>
          </div>
        </div>
      )}

      {ready &&
        view.map((b) => {
          const c = colorFor(b.key);
          const size = b.radius * 2;
          const font = fontSizeFor(b.radius, b.text);
          const mineBubble = mineKeys.has(b.key);
          return (
            <div
              key={b.key}
              ref={register(b.key)}
              className="absolute left-0 top-0 will-change-transform"
              style={{
                width: size,
                height: size,
                // Animated bubbles are positioned every frame by the hook; static ones are placed once here.
                ...(b.x !== undefined && b.y !== undefined
                  ? { transform: `translate3d(${b.x - b.radius}px, ${b.y - b.radius}px, 0)` }
                  : null),
              }}
            >
              <motion.button
                type="button"
                {...bind(b.key)}
                aria-label={`${b.text}, ${b.count} ${b.count === 1 ? "person" : "people"}${mineBubble ? ", your answer" : ""}`}
                initial={reduced ? false : { scale: 0.2, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 360, damping: 16 }}
                className="relative grid h-full w-full select-none place-items-center rounded-full text-center font-extrabold leading-tight shadow-lg outline-offset-2 focus-visible:outline-4 focus-visible:outline-white"
                style={{
                  background: c.bg,
                  color: c.ink,
                  fontSize: font,
                  touchAction: animate ? "none" : "auto",
                  cursor: animate ? "grab" : "pointer",
                  boxShadow: mineBubble ? "0 0 0 4px #fff, 0 6px 14px rgba(0,0,0,.35)" : "0 6px 14px rgba(0,0,0,.3)",
                }}
              >
                <span
                  className="line-clamp-3 max-w-[78%] [overflow-wrap:anywhere]"
                  style={{ display: "-webkit-box", WebkitBoxOrient: "vertical" }}
                >
                  {b.text}
                </span>
                {b.count > 1 && b.radius >= 26 && (
                  <span
                    className="absolute bottom-[10%] left-1/2 -translate-x-1/2 rounded-full bg-black/30 px-1.5 text-[0.7em] leading-snug text-white"
                    aria-hidden
                  >
                    ×{b.count}
                  </span>
                )}
              </motion.button>
            </div>
          );
        })}

      {/* Full text + count for the hovered / focused / tapped bubble. */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex justify-center" aria-live="polite">
        {active && (
          <p className="max-w-full break-words rounded-2xl bg-black/65 px-3 py-1.5 text-center text-sm font-extrabold backdrop-blur">
            “{active.text}” · {active.count} {active.count === 1 ? "person" : "people"}
          </p>
        )}
      </div>

      {more > 0 && (
        <p className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-black/55 px-3 py-1 text-xs font-extrabold">
          +{more} more answer{more === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}

export const BubbleCloud = memo(BubbleCloudImpl);
