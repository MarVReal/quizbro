"use client";

import Link from "next/link";
import { animate, useMotionValue, useTransform, motion } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";

export function Logo({ href = "/", small = false }: { href?: string; small?: boolean }) {
  return (
    <Link
      href={href}
      className={`font-display inline-flex items-center gap-2 font-bold ${small ? "text-xl" : "text-3xl"}`}
    >
      <span
        className="inline-grid place-items-center rounded-xl bg-accent text-accent-ink"
        style={{ width: small ? 30 : 42, height: small ? 30 : 42, transform: "rotate(-8deg)" }}
      >
        ?
      </span>
      Quizbro
    </Link>
  );
}

export function Page({
  theme = "grape",
  children,
  className = "",
}: {
  theme?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-theme={theme} className={`stage ${className}`}>
      {children}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="grid min-h-[50dvh] place-items-center" role="status" aria-label={label}>
      <motion.div
        className="h-12 w-12 rounded-full border-4 border-white/25 border-t-accent"
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
      />
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-300/40 bg-red-500/25 px-4 py-3 text-sm font-semibold"
    >
      {children}
    </div>
  );
}

/** Number that counts up/down smoothly when its value changes. */
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(value);
  const rounded = useTransform(mv, (v) => Math.round(v).toLocaleString());
  const [text, setText] = useState(Math.round(value).toLocaleString());

  useEffect(() => {
    const unsub = rounded.on("change", setText);
    const controls = animate(mv, value, { duration: 0.8, ease: "easeOut" });
    return () => {
      unsub();
      controls.stop();
    };
  }, [value, mv, rounded]);

  return <span className={className}>{text}</span>;
}

/** Circular countdown that turns red in the last seconds. */
export function TimerRing({
  secondsLeft,
  total,
  size = 76,
}: {
  secondsLeft: number;
  total: number;
  size?: number;
}) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, secondsLeft / total));
  const urgent = secondsLeft <= 5;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(255 255 255 / 0.2)" strokeWidth={8} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={urgent ? "#ff5d73" : "var(--accent)"}
          strokeWidth={8}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          style={{ transition: "stroke-dashoffset 0.25s linear, stroke 0.3s" }}
        />
      </svg>
      <motion.span
        key={urgent ? Math.ceil(secondsLeft) : "calm"}
        initial={urgent ? { scale: 1.4 } : false}
        animate={{ scale: 1 }}
        className={`font-display absolute text-2xl font-bold ${urgent ? "text-[#ff8a9b]" : ""}`}
      >
        {Math.ceil(secondsLeft)}
      </motion.span>
    </div>
  );
}

export function Confirm({
  label,
  onConfirm,
  children,
  className = "",
}: {
  label: string;
  onConfirm: () => void;
  children: ReactNode;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={className}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? label : children}
    </button>
  );
}
