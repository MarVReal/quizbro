// Bubble physics: pure functions over plain objects. No DOM, no React, no imports, so it
// is unit-testable and the rendering layer (BubbleCloud + useBubblePhysics) stays thin.
//
// Coordinates are pixels in the container's box, origin top-left. A bubble's (x, y) is its centre.

export interface Bounds {
  width: number;
  height: number;
}

/** What the server sends: one merged answer. */
export interface BubbleInput {
  key: string;
  text: string;
  count: number;
}

/** A bubble with the radius it should settle at. */
export interface SizedBubble extends BubbleInput {
  radius: number;
}

export interface Body extends SizedBubble {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Current collision radius; eases towards `radius` so growth is smooth. */
  r: number;
  /** Held by a pointer: moves with it, is not pushed by collisions. */
  pinned: boolean;
}

export type Rng = () => number;

// ───────────────────────── Tuning ─────────────────────────

/** Bubble radius limits as a fraction of the container's shorter side. */
const MIN_R_FRAC = 0.085;
const MAX_R_FRAC = 0.2;
const MIN_R_FLOOR = 22; // px, before the density cap
const ABS_MIN_R = 13; // px, never smaller than this
/** Larger counts grow quickly at first, then saturate towards the max radius. */
const GROWTH_K = 4;
/** All bubbles together may cover at most this share of the container. */
const MAX_COVERAGE = 0.45;
const RESTITUTION = 0.9;
const MAX_DT = 1 / 30;

/** Mulberry32: tiny seedable PRNG so tests (and the static layout) are deterministic. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ───────────────────────── Sizing ─────────────────────────

/** Radius limits for a container (before the density cap). */
export function radiusRange(bounds: Bounds): { min: number; max: number } {
  const m = Math.min(bounds.width, bounds.height);
  const min = Math.max(MIN_R_FLOOR, m * MIN_R_FRAC);
  const max = Math.max(min * 1.5, m * MAX_R_FRAC);
  return { min, max };
}

/** Radius for a bubble with `count` votes: never decreases as the count grows, always within [min, max]. */
export function radiusFor(count: number, min: number, max: number): number {
  const c = Math.max(1, count);
  return min + (max - min) * (1 - Math.exp(-(c - 1) / GROWTH_K));
}

/**
 * Sizes every bubble for the container. If they would cover too much of it, all radii are
 * scaled down together (relative sizes are kept) so they can always fit.
 */
export function sizeBubbles(items: BubbleInput[], bounds: Bounds): SizedBubble[] {
  if (items.length === 0 || bounds.width <= 0 || bounds.height <= 0) return [];
  const { min, max } = radiusRange(bounds);
  const raw = items.map((i) => radiusFor(i.count, min, max));
  const area = raw.reduce((s, r) => s + Math.PI * r * r, 0);
  const avail = bounds.width * bounds.height * MAX_COVERAGE;
  const scale = area > avail ? Math.sqrt(avail / area) : 1;
  return items.map((i, idx) => ({ ...i, radius: Math.max(ABS_MIN_R, raw[idx] * scale) }));
}

// ───────────────────────── Syncing with new data ─────────────────────────

function clampBody(b: Body, bounds: Bounds) {
  b.x = clamp(b.x, b.r, Math.max(b.r, bounds.width - b.r));
  b.y = clamp(b.y, b.r, Math.max(b.r, bounds.height - b.r));
}

/** Speed bubbles drift at when left alone. */
export function cruiseSpeed(bounds: Bounds): number {
  return clamp(Math.min(bounds.width, bounds.height) * 0.06, 14, 45);
}

function spawn(s: SizedBubble, existing: Body[], bounds: Bounds, rng: Rng): Body {
  // Best-candidate sampling: of a few random spots, take the one furthest from everybody else.
  const r0 = s.radius * 0.35;
  let best = { x: bounds.width / 2, y: bounds.height / 2, score: -Infinity };
  for (let k = 0; k < 10; k++) {
    const x = r0 + rng() * Math.max(0, bounds.width - 2 * r0);
    const y = r0 + rng() * Math.max(0, bounds.height - 2 * r0);
    let score = Infinity;
    for (const o of existing) score = Math.min(score, Math.hypot(o.x - x, o.y - y) - o.r);
    if (score > best.score) best = { x, y, score };
  }
  const angle = rng() * Math.PI * 2;
  const speed = cruiseSpeed(bounds);
  // Starts small and grows to full size (see step()), which reads as a pop.
  return { ...s, x: best.x, y: best.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r: r0, pinned: false };
}

/**
 * Brings the simulated bodies in line with the latest data from the server.
 * Same key → same body (position and velocity kept) with a new count/radius, so a bubble that
 * gets another vote just grows. New keys spawn; keys that disappeared are dropped.
 */
export function reconcile(bodies: Body[], sized: SizedBubble[], bounds: Bounds, rng: Rng = Math.random): Body[] {
  const byKey = new Map(bodies.map((b) => [b.key, b]));
  const out: Body[] = [];
  for (const s of sized) {
    const b = byKey.get(s.key);
    if (b) {
      b.text = s.text;
      b.count = s.count;
      b.radius = s.radius;
      out.push(b);
    } else {
      out.push(spawn(s, out, bounds, rng));
    }
  }
  for (const b of out) clampBody(b, bounds);
  return out;
}

// ───────────────────────── Simulation ─────────────────────────

/** Pairs of overlapping bodies, found with a uniform grid so it stays ~O(n) for 100+ bubbles. */
function overlappingPairs(bodies: Body[]): [number, number][] {
  const pairs: [number, number][] = [];
  if (bodies.length < 2) return pairs;
  let maxD = 0;
  for (const b of bodies) maxD = Math.max(maxD, b.r * 2);
  const cell = Math.max(1, maxD);
  const grid = new Map<number, number[]>();
  const keyOf = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;
  for (let i = 0; i < bodies.length; i++) {
    const cx = Math.floor(bodies[i].x / cell);
    const cy = Math.floor(bodies[i].y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(keyOf(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          const a = bodies[i];
          const b = bodies[j];
          const min = a.r + b.r;
          if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < min * min) pairs.push([j, i]);
        }
      }
    }
    const k = keyOf(cx, cy);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  return pairs;
}

function collide(a: Body, b: Body, rng: Rng) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    const ang = rng() * Math.PI * 2;
    dx = Math.cos(ang);
    dy = Math.sin(ang);
    d = 1;
  }
  const nx = dx / d;
  const ny = dy / d;
  const overlap = a.r + b.r - d;
  if (overlap <= 0) return;
  // Heavier (bigger) bubbles move less; a held bubble doesn't move at all.
  const ia = a.pinned ? 0 : 1 / (a.r * a.r);
  const ib = b.pinned ? 0 : 1 / (b.r * b.r);
  const sum = ia + ib;
  if (sum === 0) return;
  a.x -= nx * overlap * (ia / sum);
  a.y -= ny * overlap * (ia / sum);
  b.x += nx * overlap * (ib / sum);
  b.y += ny * overlap * (ib / sum);
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel < 0) {
    const j = (-(1 + RESTITUTION) * rel) / sum;
    a.vx -= j * ia * nx;
    a.vy -= j * ia * ny;
    b.vx += j * ib * nx;
    b.vy += j * ib * ny;
  }
}

/** Advances the simulation by `dt` seconds (clamped, so a stalled tab can't explode it). Mutates `bodies`. */
export function step(bodies: Body[], bounds: Bounds, dt: number, rng: Rng = Math.random): void {
  dt = clamp(dt, 0, MAX_DT);
  if (dt === 0 || bodies.length === 0) return;
  const cruise = cruiseSpeed(bounds);
  const vmax = cruise * 3;

  for (const b of bodies) {
    b.r += (b.radius - b.r) * (1 - Math.exp(-dt * 7));
    if (b.pinned) continue;

    const speed = Math.hypot(b.vx, b.vy);
    if (speed < 1e-3) {
      const ang = rng() * Math.PI * 2;
      b.vx = Math.cos(ang) * cruise;
      b.vy = Math.sin(ang) * cruise;
    } else if (speed < cruise) {
      const k = 1 + (cruise / speed - 1) * Math.min(1, dt * 2);
      b.vx *= k;
      b.vy *= k;
    } else if (speed > vmax) {
      const k = Math.exp(-dt * 1.5);
      b.vx *= k;
      b.vy *= k;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }

  // Two relaxation passes keep crowded clusters from jittering through each other.
  for (let pass = 0; pass < 2; pass++) {
    for (const [i, j] of overlappingPairs(bodies)) collide(bodies[i], bodies[j], rng);
    for (const b of bodies) wallBounce(b, bounds);
  }
}

function wallBounce(b: Body, bounds: Bounds) {
  const maxX = Math.max(b.r, bounds.width - b.r);
  const maxY = Math.max(b.r, bounds.height - b.r);
  if (b.x < b.r) {
    b.x = b.r;
    b.vx = Math.abs(b.vx);
  } else if (b.x > maxX) {
    b.x = maxX;
    b.vx = -Math.abs(b.vx);
  }
  if (b.y < b.r) {
    b.y = b.r;
    b.vy = Math.abs(b.vy);
  } else if (b.y > maxY) {
    b.y = maxY;
    b.vy = -Math.abs(b.vy);
  }
}

// ───────────────────────── Dragging ─────────────────────────

/** Moves a held bubble to (x, y), kept inside the container. */
export function dragTo(b: Body, x: number, y: number, bounds: Bounds) {
  b.pinned = true;
  b.x = clamp(x, b.r, Math.max(b.r, bounds.width - b.r));
  b.y = clamp(y, b.r, Math.max(b.r, bounds.height - b.r));
  b.vx = 0;
  b.vy = 0;
}

/** Lets go of a held bubble, flinging it with the pointer's velocity (px/s), capped to stay controllable. */
export function release(b: Body, vx: number, vy: number, bounds: Bounds) {
  b.pinned = false;
  const max = cruiseSpeed(bounds) * 8;
  const s = Math.hypot(vx, vy);
  const k = s > max ? max / s : 1;
  b.vx = vx * k;
  b.vy = vy * k;
}

// ───────────────────────── Static layout (reduced motion) ─────────────────────────

export interface PlacedBubble extends SizedBubble {
  x: number;
  y: number;
}

/**
 * A fixed, non-overlapping arrangement: biggest bubbles near the middle, the rest spiralling out.
 * Deterministic. If everything can't fit, all radii shrink together until it does.
 */
export function packLayout(sized: SizedBubble[], bounds: Bounds): PlacedBubble[] {
  if (sized.length === 0 || bounds.width <= 0 || bounds.height <= 0) return [];
  const order = [...sized].sort((a, b) => b.radius - a.radius || (a.key < b.key ? -1 : 1));
  const cx = bounds.width / 2;
  const cy = bounds.height / 2;
  const aspect = bounds.height / bounds.width;
  const gap = 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  // Candidate spots spiral out from the centre and must reach the far corners of the box.
  const CANDIDATES = 4000;
  const spacing = Math.max(1, Math.hypot(bounds.width, bounds.height) / 2 / Math.sqrt(CANDIDATES));

  let scale = 1;
  for (let attempt = 0; attempt < 60; attempt++) {
    const placed: PlacedBubble[] = [];
    let ok = true;
    for (const s of order) {
      const r = s.radius * scale;
      let spot: { x: number; y: number } | null = null;
      for (let i = 0; i < CANDIDATES; i++) {
        const d = spacing * Math.sqrt(i);
        const x = cx + d * Math.cos(i * golden);
        const y = cy + d * Math.sin(i * golden) * aspect;
        if (x - r < 0 || y - r < 0 || x + r > bounds.width || y + r > bounds.height) continue;
        if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.radius + r + gap)) {
          spot = { x, y };
          break;
        }
      }
      if (!spot) {
        ok = false;
        break;
      }
      placed.push({ ...s, radius: r, x: spot.x, y: spot.y });
    }
    if (ok) return placed;
    scale *= 0.92;
  }
  return [];
}
