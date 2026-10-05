"use client";

import { useGSAP } from "@gsap/react";
import { useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { memo, useRef } from "react";
import type { FeedItem } from "@/lib/multi-answer";

gsap.registerPlugin(useGSAP);

/** A stable, friendly colour per person, so you can follow who is who at a glance. */
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

interface Props {
  items: FeedItem[];
  /** How many of the newest messages stay on screen; older ones scroll away. */
  visible?: number;
  /** "lg" for the big host screen. */
  size?: "sm" | "lg";
  className?: string;
}

/**
 * A live-stream style chat: new answers pop in at the bottom-left with the sender's name and
 * push the older ones up, which fade out at the top. It never blocks touches on what is
 * behind it (the bubbles). Movement is GSAP; with prefers-reduced-motion messages simply appear.
 */
function ChatFeedImpl({ items, visible = 6, size = "sm", className = "" }: Props) {
  const reduced = useReducedMotion() ?? false;
  const root = useRef<HTMLUListElement>(null);
  const seen = useRef<Set<number> | null>(null);
  const shown = items.slice(-visible);
  const signature = shown.map((i) => i.id).join(",");
  const lg = size === "lg";

  // Animate only messages that weren't on screen before; whatever is already there when this first mounts just appears.
  useGSAP(
    () => {
      const known = seen.current;
      seen.current = new Set(shown.map((i) => i.id));
      if (!known || reduced) return;
      const fresh = shown.filter((i) => !known.has(i.id));
      fresh.forEach((item, n) => {
        const wrap = root.current?.querySelector(`[data-chat-id="${item.id}"]`);
        if (!wrap) return;
        // Staggered, so a burst of answers streams in instead of landing all at once.
        const delay = n * 0.16;
        gsap.fromTo(
          wrap,
          { height: 0, opacity: 0, x: -34 },
          { height: "auto", opacity: 1, x: 0, duration: 0.5, delay, ease: "power3.out", clearProps: "height,transform" },
        );
        gsap.fromTo(
          wrap.firstElementChild,
          { scale: 0.82 },
          { scale: 1, duration: 0.6, delay, ease: "back.out(2.6)", transformOrigin: "left bottom" },
        );
      });
    },
    { scope: root, dependencies: [signature, reduced] },
  );

  return (
    <ul
      ref={root}
      aria-label="Live answers"
      aria-live="polite"
      className={`pointer-events-none flex list-none flex-col justify-end gap-1.5 overflow-hidden p-0 [mask-image:linear-gradient(to_top,black_62%,transparent)] ${className}`}
    >
      {shown.map((m) => {
        const hue = hueFor(m.name);
        return (
          <li key={m.id} data-chat-id={m.id} className="overflow-hidden">
            <div
              className={`flex w-fit max-w-full items-start gap-2 rounded-2xl bg-black/50 backdrop-blur-sm ${
                lg ? "px-3.5 py-2" : "px-2.5 py-1.5"
              } ${m.is_me ? "ring-2 ring-white/80" : ""}`}
            >
              <span
                aria-hidden
                className={`grid shrink-0 place-items-center rounded-full font-extrabold text-[#1a0b36] ${
                  lg ? "h-8 w-8 text-base" : "h-6 w-6 text-xs"
                }`}
                style={{ background: `hsl(${hue} 85% 72%)` }}
              >
                {[...m.name][0]?.toUpperCase() ?? "?"}
              </span>
              <p className={`min-w-0 break-words leading-snug ${lg ? "text-lg" : "text-sm"}`}>
                <span className="font-extrabold" style={{ color: `hsl(${hue} 90% 78%)` }}>
                  {m.is_me ? "You" : m.name}
                </span>{" "}
                <span className="font-bold text-white">{m.text}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export const ChatFeed = memo(ChatFeedImpl);
