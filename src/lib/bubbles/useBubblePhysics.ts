"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  dragTo,
  packLayout,
  reconcile,
  release,
  sizeBubbles,
  step,
  type Body,
  type Bounds,
  type BubbleInput,
  type SizedBubble,
} from "./physics";

export interface RenderBubble extends SizedBubble {
  /** Only set for the static (reduced-motion) layout; animated bubbles are positioned imperatively. */
  x?: number;
  y?: number;
}

interface Drag {
  key: string;
  pointerId: number;
  rect: DOMRect;
  offX: number;
  offY: number;
  startX: number;
  startY: number;
  moved: boolean;
  samples: { t: number; x: number; y: number }[];
}

const TAP_SLOP = 6; // px of travel before a press counts as a drag, not a tap

/**
 * Owns the bubble simulation for one container:
 *  - measures the container (ResizeObserver) and sizes/reconciles bodies against the latest data,
 *  - runs a requestAnimationFrame loop that writes only `transform` to the bubble elements
 *    (no React re-render per frame), and pauses while the tab is hidden,
 *  - with `animate: false` (prefers-reduced-motion) renders a static, non-overlapping layout instead,
 *  - exposes pointer handlers for hover/tap info and drag-and-fling.
 * All the maths lives in ./physics (pure, unit-tested).
 */
export function useBubblePhysics(items: BubbleInput[], animate: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const boundsRef = useRef<Bounds | null>(null);
  const bodiesRef = useRef<Body[]>([]);
  const elsRef = useRef(new Map<string, HTMLElement>());
  const refCache = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const dragRef = useRef<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [tapped, setTapped] = useState<string | null>(null);

  // Track the container size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setBounds((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sized = useMemo(() => (bounds ? sizeBubbles(items, bounds) : []), [items, bounds]);
  const view = useMemo<RenderBubble[]>(
    () => (animate || !bounds ? sized : packLayout(sized, bounds)),
    [animate, bounds, sized],
  );

  const paint = useCallback(() => {
    for (const b of bodiesRef.current) {
      const el = elsRef.current.get(b.key);
      if (el) el.style.transform = `translate3d(${b.x - b.radius}px, ${b.y - b.radius}px, 0) scale(${b.r / b.radius})`;
    }
  }, []);

  // Sync the simulation with new data / a new container size before the browser paints.
  useLayoutEffect(() => {
    boundsRef.current = bounds;
    if (!animate || !bounds) {
      bodiesRef.current = [];
      return;
    }
    bodiesRef.current = reconcile(bodiesRef.current, sized, bounds);
    paint();
  }, [animate, bounds, sized, paint]);

  // The animation loop. Pauses when the tab is hidden and resumes without a time jump.
  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      const b = boundsRef.current;
      if (b) {
        step(bodiesRef.current, b, last ? (t - last) / 1000 : 0);
        paint();
      }
      last = t;
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (raf) return;
      last = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [animate, paint]);

  // Stable ref callbacks per key so React doesn't detach/attach every render.
  const register = useCallback((key: string) => {
    let fn = refCache.current.get(key);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        if (el) elsRef.current.set(key, el);
        else {
          elsRef.current.delete(key);
          refCache.current.delete(key);
        }
      };
      refCache.current.set(key, fn);
    }
    return fn;
  }, []);

  const bodyFor = (key: string) => bodiesRef.current.find((b) => b.key === key);

  // Pointer handlers for one bubble: hover/tap show details; in animated mode you can also drag and fling.
  const bind = (key: string) => ({
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") setHover(key);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") setHover((h) => (h === key ? null : h));
    },
    onFocus: () => setHover(key),
    onBlur: () => setHover((h) => (h === key ? null : h)),
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      const container = containerRef.current;
      const body = bodyFor(key);
      if (!container || !animate || !body || e.button > 0) return;
      const rect = container.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        key,
        pointerId: e.pointerId,
        rect,
        offX: px - body.x,
        offY: py - body.y,
        startX: px,
        startY: py,
        moved: false,
        samples: [{ t: performance.now(), x: px, y: py }],
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = dragRef.current;
      const body = d && d.key === key ? bodyFor(key) : undefined;
      const b = boundsRef.current;
      if (!d || !body || !b || d.pointerId !== e.pointerId) return;
      const px = e.clientX - d.rect.left;
      const py = e.clientY - d.rect.top;
      if (!d.moved && Math.hypot(px - d.startX, py - d.startY) > TAP_SLOP) d.moved = true;
      if (!d.moved) return;
      dragTo(body, px - d.offX, py - d.offY, b);
      d.samples.push({ t: performance.now(), x: px, y: py });
      if (d.samples.length > 8) d.samples.shift();
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.key !== key || d.pointerId !== e.pointerId) return;
      dragRef.current = null;
      const body = bodyFor(key);
      const b = boundsRef.current;
      if (!d.moved) {
        setTapped((t) => (t === key ? null : key));
        return;
      }
      if (!body || !b) return;
      // Fling with the pointer's velocity over the last ~120 ms.
      const now = performance.now();
      const recent = d.samples.filter((s) => now - s.t <= 120);
      let vx = 0;
      let vy = 0;
      if (recent.length >= 2) {
        const a = recent[0];
        const z = recent[recent.length - 1];
        const dt = (z.t - a.t) / 1000;
        if (dt > 0) {
          vx = (z.x - a.x) / dt;
          vy = (z.y - a.y) / dt;
        }
      }
      release(body, vx, vy, b);
    },
    onPointerCancel: () => {
      const d = dragRef.current;
      if (!d || d.key !== key) return;
      dragRef.current = null;
      const body = bodyFor(key);
      const b = boundsRef.current;
      if (body && b) release(body, 0, 0, b);
    },
  });

  // Show details for whatever is hovered/focused, falling back to the last tapped bubble.
  const activeKey = hover ?? tapped;
  const clearTap = () => setTapped(null);

  return { containerRef, view, register, bind, activeKey, clearTap, ready: bounds !== null };
}
