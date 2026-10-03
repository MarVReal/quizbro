"use client";

import { QRCodeCanvas } from "qrcode.react";
import { useRef, useState, type ReactNode } from "react";

export function QRCard({
  title,
  badge,
  url,
  filename,
  children,
  tone = "player",
}: {
  title: string;
  badge: string;
  url: string;
  filename: string;
  children?: ReactNode;
  tone?: "player" | "host";
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  function download() {
    const canvas = wrap.current?.querySelector("canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${filename}.png`;
    a.click();
  }

  return (
    <section className="card flex flex-col items-center gap-4 p-6 text-center">
      <span
        className={`rounded-full px-3 py-1 text-xs font-extrabold uppercase tracking-wider ${
          tone === "host" ? "bg-[#ff5d73] text-white" : "bg-accent text-accent-ink"
        }`}
      >
        {badge}
      </span>
      <h2 className="font-display text-2xl font-semibold">{title}</h2>
      <div ref={wrap} className="rounded-3xl bg-white p-4 shadow-xl">
        <QRCodeCanvas value={url} size={220} marginSize={0} level="M" bgColor="#ffffff" fgColor="#1a0b36" />
      </div>
      {children}
      <div className="no-print flex flex-wrap justify-center gap-2">
        <button onClick={copy} className="btn btn-ghost px-4 py-2 text-sm">
          {copied ? "Copied ✓" : "Copy link"}
        </button>
        <button onClick={download} className="btn btn-ghost px-4 py-2 text-sm">
          Save PNG
        </button>
      </div>
    </section>
  );
}
