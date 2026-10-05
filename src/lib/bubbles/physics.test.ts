import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cruiseSpeed,
  dragTo,
  mulberry32,
  packLayout,
  radiusFor,
  radiusRange,
  reconcile,
  release,
  sizeBubbles,
  step,
  type Body,
  type BubbleInput,
  type PlacedBubble,
} from "./physics.ts";

const desktop = { width: 900, height: 420 };
const phone = { width: 340, height: 380 };

const items = (counts: number[]): BubbleInput[] =>
  counts.map((count, i) => ({ key: `k${i}`, text: `answer ${i}`, count }));

function settle(bodies: Body[], bounds = desktop, steps = 600, seed = 1) {
  const rng = mulberry32(seed);
  for (let i = 0; i < steps; i++) step(bodies, bounds, 1 / 60, rng);
}

function maxPenetration(bodies: { x: number; y: number; r: number }[]) {
  let worst = 0;
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) {
      const d = Math.hypot(bodies[i].x - bodies[j].x, bodies[i].y - bodies[j].y);
      worst = Math.max(worst, bodies[i].r + bodies[j].r - d);
    }
  return worst;
}

function inside(b: { x: number; y: number; r: number }, bounds = desktop, eps = 1e-6) {
  return b.x - b.r >= -eps && b.y - b.r >= -eps && b.x + b.r <= bounds.width + eps && b.y + b.r <= bounds.height + eps;
}

describe("mulberry32", () => {
  test("is deterministic per seed and stays in [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      assert.equal(v, b());
      assert.ok(v >= 0 && v < 1);
    }
    assert.notEqual(mulberry32(1)(), mulberry32(2)());
  });
});

describe("sizing", () => {
  test("radius never shrinks as the count grows and stays inside [min, max]", () => {
    const { min, max } = radiusRange(desktop);
    let prev = 0;
    for (let c = 1; c <= 500; c++) {
      const r = radiusFor(c, min, max);
      assert.ok(r >= prev - 1e-9, `count ${c}`);
      assert.ok(r >= min - 1e-9 && r <= max + 1e-9);
      prev = r;
    }
    assert.equal(radiusFor(1, min, max), min);
    assert.equal(radiusFor(0, min, max), min, "counts below 1 are treated as 1");
    assert.ok(radiusFor(2, min, max) > min, "a second vote visibly grows the bubble");
  });

  test("a few bubbles keep a readable size", () => {
    const sized = sizeBubbles(items([1, 1, 1]), phone);
    for (const s of sized) assert.ok(s.radius >= 22);
  });

  test("bigger count means bigger bubble; order and keys are preserved", () => {
    const sized = sizeBubbles(items([1, 5, 12]), desktop);
    assert.deepEqual(sized.map((s) => s.key), ["k0", "k1", "k2"]);
    assert.ok(sized[0].radius < sized[1].radius && sized[1].radius < sized[2].radius);
  });

  test("a crowd is scaled down together so it fits, keeping relative sizes", () => {
    const many = items(Array.from({ length: 50 }, (_, i) => (i === 0 ? 9 : 1)));
    const sized = sizeBubbles(many, phone);
    const covered = sized.reduce((s, b) => s + Math.PI * b.radius ** 2, 0);
    assert.ok(covered <= phone.width * phone.height * 0.45 + 1, `coverage ${covered}`);
    assert.ok(sized[0].radius > sized[1].radius);
    for (const s of sized) assert.ok(s.radius >= 13);
  });

  test("nothing to size, or no room", () => {
    assert.deepEqual(sizeBubbles([], desktop), []);
    assert.deepEqual(sizeBubbles(items([1]), { width: 0, height: 100 }), []);
  });
});

describe("reconcile (merging live data into bodies)", () => {
  test("a bubble that gets another vote keeps its place and velocity but grows", () => {
    const rng = mulberry32(3);
    let bodies = reconcile([], sizeBubbles(items([1, 1]), desktop), desktop, rng);
    settle(bodies, desktop, 120);
    const before = { ...bodies[0] };
    const rBefore = bodies[0].radius;
    bodies = reconcile(bodies, sizeBubbles(items([4, 1]), desktop), desktop, rng);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].x, before.x);
    assert.equal(bodies[0].vx, before.vx);
    assert.equal(bodies[0].count, 4);
    assert.ok(bodies[0].radius > rBefore, "target radius grows");
    assert.equal(bodies[0].r, before.r, "current radius eases up in step(), not instantly");
    settle(bodies, desktop, 120);
    assert.ok(Math.abs(bodies[0].r - bodies[0].radius) < 0.5, "and gets there");
  });

  test("new answers spawn small and inside the box; vanished ones are dropped", () => {
    const rng = mulberry32(4);
    let bodies = reconcile([], sizeBubbles(items([1, 1, 1]), desktop), desktop, rng);
    const keep = bodies[1];
    const fresh: BubbleInput = { key: "new", text: "new", count: 1 };
    bodies = reconcile(bodies, sizeBubbles([items([1, 1, 1])[1], fresh], desktop), desktop, rng);
    assert.deepEqual(bodies.map((b) => b.key), ["k1", "new"]);
    assert.equal(bodies[0], keep, "same object, so a DOM node can stay bound to it");
    const born = bodies[1];
    assert.ok(born.r < born.radius, "pops in from small");
    assert.ok(inside(born));
  });

  test("spawning is deterministic for a seed", () => {
    const a = reconcile([], sizeBubbles(items([1, 2, 3]), desktop), desktop, mulberry32(9));
    const b = reconcile([], sizeBubbles(items([1, 2, 3]), desktop), desktop, mulberry32(9));
    assert.deepEqual(a, b);
  });

  test("shrinking the container pulls bodies back inside", () => {
    const rng = mulberry32(5);
    let bodies = reconcile([], sizeBubbles(items([3, 3, 3, 3]), desktop), desktop, rng);
    settle(bodies, desktop, 60);
    bodies = reconcile(bodies, sizeBubbles(items([3, 3, 3, 3]), phone), phone, rng);
    for (const b of bodies) assert.ok(inside({ ...b, r: Math.min(b.r, b.radius) }, phone));
  });

  test("an empty list clears everything", () => {
    const bodies = reconcile([], sizeBubbles(items([1]), desktop), desktop, mulberry32(1));
    assert.deepEqual(reconcile(bodies, [], desktop), []);
  });
});

describe("step", () => {
  test("bubbles never leave the container, however long they run", () => {
    const bodies = reconcile([], sizeBubbles(items([1, 2, 3, 1, 5, 1, 1, 8, 2, 1]), phone), phone, mulberry32(11));
    for (let i = 0; i < 3000; i++) {
      step(bodies, phone, 1 / 60, mulberry32(i));
      for (const b of bodies) assert.ok(inside(b, phone, 1e-6), `frame ${i}`);
    }
  });

  test("a lone bubble bounces off walls without losing speed", () => {
    const [b] = reconcile([], sizeBubbles(items([1]), desktop), desktop, mulberry32(2));
    const speed0 = Math.hypot(b.vx, b.vy);
    let bounced = false;
    for (let i = 0; i < 6000; i++) {
      const vx = b.vx;
      step([b], desktop, 1 / 60);
      if (Math.sign(vx) !== Math.sign(b.vx)) bounced = true;
    }
    assert.ok(bounced, "it hit a wall");
    assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - speed0) < 1e-6);
  });

  test("a bubble moving into a wall is reflected", () => {
    const b: Body = { key: "a", text: "a", count: 1, radius: 20, r: 20, x: 21, y: 100, vx: -100, vy: 0, pinned: false };
    step([b], desktop, 1 / 30);
    assert.ok(b.vx > 0);
    assert.ok(b.x >= 20);
  });

  test("a stalled tab (huge dt) cannot teleport or explode anything", () => {
    const b: Body = { key: "a", text: "a", count: 1, radius: 20, r: 20, x: 100, y: 100, vx: 40, vy: 0, pinned: false };
    step([b], desktop, 10);
    assert.ok(b.x - 100 <= 40 / 30 + 1e-6);
  });

  test("a drifting bubble that has stopped starts moving again; a fast one calms down", () => {
    const slow: Body = { key: "s", text: "s", count: 1, radius: 20, r: 20, x: 200, y: 200, vx: 0, vy: 0, pinned: false };
    step([slow], desktop, 1 / 60, mulberry32(1));
    assert.ok(Math.hypot(slow.vx, slow.vy) > 0);
    const fast: Body = { key: "f", text: "f", count: 1, radius: 20, r: 20, x: 200, y: 200, vx: 1000, vy: 0, pinned: false };
    for (let i = 0; i < 600; i++) {
      fast.x = 200;
      fast.y = 200; // stay clear of walls so only the speed limit acts
      step([fast], desktop, 1 / 60);
    }
    assert.ok(Math.hypot(fast.vx, fast.vy) <= cruiseSpeed(desktop) * 3 * 1.05);
  });

  test("colliding bubbles push apart and bounce; heavier ones move less", () => {
    const big: Body = { key: "b", text: "b", count: 9, radius: 60, r: 60, x: 300, y: 200, vx: 0, vy: 0, pinned: false };
    const small: Body = { key: "s", text: "s", count: 1, radius: 20, r: 20, x: 355, y: 200, vx: 0, vy: 0, pinned: false };
    const bigX = big.x;
    const smallX = small.x;
    step([big, small], desktop, 1 / 60, mulberry32(1));
    assert.ok(maxPenetration([big, small]) < 1, "no longer overlapping");
    assert.ok(Math.abs(big.x - bigX) < Math.abs(small.x - smallX), "the small one is pushed further");
    assert.ok(small.x > big.x);
  });

  test("a head-on hit between equal bubbles reverses both and conserves momentum", () => {
    const mk = (key: string, x: number, vx: number): Body => ({
      key, text: key, count: 1, radius: 30, r: 30, x, y: 200, vx, vy: 0, pinned: false,
    });
    const a = mk("a", 400, 80);
    const b = mk("b", 455, -80);
    const p0 = a.vx + b.vx;
    step([a, b], desktop, 1 / 60, mulberry32(1));
    assert.ok(a.vx < 0 && b.vx > 0);
    assert.ok(Math.abs(a.vx + b.vx - p0) < 1e-6);
  });

  test("two bubbles stacked on the exact same spot are separated, not NaN", () => {
    const mk = (key: string): Body => ({ key, text: key, count: 1, radius: 30, r: 30, x: 200, y: 200, vx: 0, vy: 0, pinned: false });
    const bodies = [mk("a"), mk("b")];
    step(bodies, desktop, 1 / 60, mulberry32(1));
    for (const b of bodies) assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
    assert.ok(maxPenetration(bodies) < 1);
  });

  test("a roomy container settles with only slight overlaps", () => {
    const bodies = reconcile([], sizeBubbles(items(Array.from({ length: 30 }, (_, i) => 1 + (i % 6))), desktop), desktop, mulberry32(21));
    settle(bodies, desktop, 900);
    const minR = Math.min(...bodies.map((b) => b.r));
    assert.ok(maxPenetration(bodies) < minR * 0.35, `penetration ${maxPenetration(bodies)}`);
  });

  test("a full 50-bubble phone settles with bounded overlaps", () => {
    const bodies = reconcile([], sizeBubbles(items(Array.from({ length: 50 }, (_, i) => 1 + (i % 4))), phone), phone, mulberry32(8));
    settle(bodies, phone, 900, 3);
    const minR = Math.min(...bodies.map((b) => b.r));
    assert.ok(maxPenetration(bodies) < minR * 0.6, `penetration ${maxPenetration(bodies)} vs min r ${minR}`);
    for (const b of bodies) assert.ok(inside(b, phone, 1e-6));
  });
});

describe("dragging", () => {
  test("a held bubble follows the pointer, is clamped to the box and ignores collisions", () => {
    const held: Body = { key: "h", text: "h", count: 1, radius: 30, r: 30, x: 100, y: 100, vx: 50, vy: 50, pinned: false };
    const other: Body = { key: "o", text: "o", count: 1, radius: 30, r: 30, x: 140, y: 100, vx: 0, vy: 0, pinned: false };
    dragTo(held, 130, 100, desktop);
    assert.equal(held.pinned, true);
    assert.deepEqual([held.vx, held.vy], [0, 0]);
    step([held, other], desktop, 1 / 60, mulberry32(1));
    assert.equal(held.x, 130);
    assert.ok(other.x - held.x >= 59, "the other bubble was pushed away");
    dragTo(held, -500, 9999, desktop);
    assert.ok(inside(held));
  });

  test("a released bubble keeps the fling velocity, capped", () => {
    const b: Body = { key: "h", text: "h", count: 1, radius: 30, r: 30, x: 100, y: 100, vx: 0, vy: 0, pinned: true };
    release(b, 100, 0, desktop);
    assert.equal(b.pinned, false);
    assert.equal(b.vx, 100);
    release(b, 1e6, 0, desktop);
    assert.ok(Math.hypot(b.vx, b.vy) <= cruiseSpeed(desktop) * 8 + 1e-6);
  });
});

describe("packLayout (static, for reduced motion)", () => {
  function assertValid(placed: PlacedBubble[], bounds: { width: number; height: number }) {
    for (const p of placed) {
      assert.ok(p.x - p.radius >= 0 && p.y - p.radius >= 0 && p.x + p.radius <= bounds.width && p.y + p.radius <= bounds.height, `${p.key} inside`);
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const d = Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y);
        assert.ok(d >= placed[i].radius + placed[j].radius, `${placed[i].key}/${placed[j].key} overlap`);
      }
  }

  test("places everything inside the box without overlaps", () => {
    for (const bounds of [desktop, phone]) {
      const placed = packLayout(sizeBubbles(items([1, 3, 7, 1, 2, 1, 5, 1, 1, 2]), bounds), bounds);
      assert.equal(placed.length, 10);
      assertValid(placed, bounds);
    }
  });

  test("uses the whole box: on a wide desktop bubbles keep their full size", () => {
    const sized = sizeBubbles(items(Array.from({ length: 33 }, (_, i) => 1 + (i % 7))), desktop);
    const placed = packLayout(sized, desktop);
    assert.equal(placed.length, 33);
    assertValid(placed, desktop);
    for (const p of placed) {
      const original = sized.find((s) => s.key === p.key)!;
      assert.ok(p.radius >= original.radius * 0.9, `${p.key} shrank from ${original.radius} to ${p.radius}`);
    }
    const spread = Math.max(...placed.map((p) => Math.abs(p.x - desktop.width / 2)));
    assert.ok(spread > desktop.width * 0.25, "bubbles spread across the width, not just the middle");
  });

  test("a full crowd of 50 on a phone still packs without overlaps", () => {
    const placed = packLayout(sizeBubbles(items(Array.from({ length: 50 }, (_, i) => 1 + (i % 5))), phone), phone);
    assert.equal(placed.length, 50);
    assertValid(placed, phone);
  });

  test("oversized bubbles are shrunk together until they fit", () => {
    const huge = items([1, 1, 1, 1]).map((i) => ({ ...i, radius: 400 }));
    const placed = packLayout(huge, phone);
    assert.equal(placed.length, 4);
    assertValid(placed, phone);
    assert.ok(placed[0].radius < 400);
  });

  test("is deterministic, puts the biggest bubble nearest the middle, handles empty/zero input", () => {
    const sized = sizeBubbles(items([1, 9, 2]), desktop);
    const a = packLayout(sized, desktop);
    assert.deepEqual(a, packLayout(sized, desktop));
    const dist = (p: PlacedBubble) => Math.hypot(p.x - desktop.width / 2, p.y - desktop.height / 2);
    const biggest = a.find((p) => p.key === "k1")!;
    assert.ok(dist(biggest) <= Math.min(...a.map(dist)) + 1e-9);
    assert.deepEqual(packLayout([], desktop), []);
    assert.deepEqual(packLayout(sized, { width: 0, height: 0 }), []);
  });
});

describe("performance", () => {
  test("150 bubbles step comfortably within a 60fps frame budget", () => {
    const wide = { width: 1400, height: 800 };
    const bodies = reconcile([], sizeBubbles(items(Array.from({ length: 150 }, (_, i) => 1 + (i % 6))), wide), wide, mulberry32(5));
    const rng = mulberry32(6);
    for (let i = 0; i < 120; i++) step(bodies, wide, 1 / 60, rng); // warm up
    const frames = 600;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) step(bodies, wide, 1 / 60, rng);
    const perFrame = (performance.now() - t0) / frames;
    console.log(`# 150 bubbles: ${perFrame.toFixed(3)} ms/step`);
    assert.ok(perFrame < 4, `${perFrame} ms/step`); // a 16.7 ms frame; leaves plenty for paint
  });
});
