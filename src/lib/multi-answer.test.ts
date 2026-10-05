import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ANSWER_COOLDOWN_S,
  cleanAnswer,
  charCount,
  clampInt,
  mergeBubbles,
  normalizeAnswer,
  validateNextAnswer,
} from "./multi-answer.ts";

const limits = { maxAnswers: 3, maxChars: 10 };

describe("cleanAnswer / normalizeAnswer", () => {
  test("trims and collapses any whitespace, including tabs, newlines and no-break spaces", () => {
    assert.equal(cleanAnswer("  hello \t\n  world\u00a0\u00a0! "), "hello world !");
  });

  test("keeps the original casing for display but lower-cases the merge key", () => {
    assert.equal(cleanAnswer("  Pizza "), "Pizza");
    assert.equal(normalizeAnswer("  Pizza "), "pizza");
  });

  test("mixed-case and differently spaced duplicates share one key", () => {
    const keys = new Set(["Pizza", "pizza", "PIZZA", " pizza ", "pi zza".replace(" ", "")].map(normalizeAnswer));
    assert.equal(keys.size, 1);
    assert.equal(normalizeAnswer("New  York"), normalizeAnswer("new york"));
  });

  test("different words stay different", () => {
    assert.notEqual(normalizeAnswer("Pizza"), normalizeAnswer("Pizzas"));
  });

  test("emoji pass through untouched", () => {
    assert.equal(cleanAnswer(" 🍕 "), "🍕");
    assert.equal(normalizeAnswer("🍕"), "🍕");
  });
});

describe("charCount", () => {
  test("counts characters (code points), not UTF-16 units", () => {
    assert.equal(charCount("abc"), 3);
    assert.equal(charCount("🍕"), 1); // .length would be 2
    assert.equal(charCount("🍕🍕🍕"), 3);
    assert.equal(charCount(""), 0);
  });
});

describe("validateNextAnswer", () => {
  test("accepts a good answer and returns it trimmed and space-collapsed", () => {
    assert.deepEqual(validateNextAnswer("  ta   cos ", [], limits), { ok: true, answer: "ta cos" });
  });

  test("rejects blanks and whitespace-only answers", () => {
    for (const blank of ["", "   ", "\t\n", "\u00a0"]) {
      assert.deepEqual(validateNextAnswer(blank, [], limits), { ok: false, error: "Type an answer first" });
    }
  });

  test("enforces the max length exactly at the boundary, after trimming", () => {
    assert.equal(validateNextAnswer("x".repeat(10), [], limits).ok, true);
    assert.equal(validateNextAnswer("   " + "x".repeat(10) + "   ", [], limits).ok, true);
    assert.deepEqual(validateNextAnswer("x".repeat(11), [], limits), {
      ok: false,
      error: "Keep each answer to 10 characters or fewer",
    });
  });

  test("emoji each count as one character", () => {
    assert.equal(validateNextAnswer("🍕".repeat(10), [], limits).ok, true);
    assert.equal(validateNextAnswer("🍕".repeat(11), [], limits).ok, false);
  });

  test("a very long single word is rejected rather than truncated", () => {
    assert.equal(validateNextAnswer("supercalifragilisticexpialidocious", [], limits).ok, false);
  });

  test("refuses an answer you already sent, ignoring case and spacing", () => {
    const mine = ["Pizza", "New York"];
    for (const dup of ["pizza", "  PIZZA ", "new   york"]) {
      assert.deepEqual(validateNextAnswer(dup, mine, limits), { ok: false, error: "You already gave that answer" });
    }
    assert.equal(validateNextAnswer("Pizzas", mine, limits).ok, true);
  });

  test("stops once all answers are used, even for a perfectly good one", () => {
    assert.deepEqual(validateNextAnswer("fresh", ["a", "b", "c"], limits), {
      ok: false,
      error: "You have used all your answers",
    });
    assert.equal(validateNextAnswer("fresh", ["a", "b"], limits).ok, true);
  });

  test("a one-answer question allows exactly one", () => {
    const one = { maxAnswers: 1, maxChars: 10 };
    assert.equal(validateNextAnswer("a", [], one).ok, true);
    assert.equal(validateNextAnswer("b", ["a"], one).ok, false);
  });
});

test("the cooldown between answers is a few seconds (and matches the server)", () => {
  assert.equal(ANSWER_COOLDOWN_S, 3);
});

describe("clampInt", () => {
  test("keeps values in range and rounds", () => {
    assert.equal(clampInt(5, 1, 20), 5);
    assert.equal(clampInt(0, 1, 20), 1);
    assert.equal(clampInt(99, 1, 20), 20);
    assert.equal(clampInt(4.6, 1, 20), 5);
  });
  test("falls back to the minimum for NaN / Infinity", () => {
    assert.equal(clampInt(Number.NaN, 1, 20), 1);
    assert.equal(clampInt(Number.POSITIVE_INFINITY, 1, 20), 1);
  });
});

describe("mergeBubbles (what I see right after sending)", () => {
  const bubble = (text: string, count: number) => ({ key: text.toLowerCase(), text, count });

  test("before I have sent anything and the server has nothing, there is nothing to show", () => {
    assert.equal(mergeBubbles(undefined, []), undefined);
    assert.equal(mergeBubbles(null, []), undefined);
  });

  test("my own answer appears straight away, even before the server has counted it", () => {
    const merged = mergeBubbles(undefined, ["  DATA "]);
    assert.deepEqual(merged, { items: [{ key: "data", text: "DATA", count: 1 }], more: 0 });
  });

  test("answers the server already has are left exactly as the server counted them", () => {
    const server = { items: [bubble("DATA", 7), bubble("Cloud", 2)], more: 3 };
    const merged = mergeBubbles(server, ["data", "CLOUD"]);
    assert.deepEqual(merged, server);
  });

  test("only the missing ones are added, at the bottom with a count of 1", () => {
    const server = { items: [bubble("DATA", 7)], more: 0 };
    const merged = mergeBubbles(server, ["Data", "Sushi"]);
    assert.deepEqual(merged?.items.map((i) => [i.key, i.count]), [["data", 7], ["sushi", 1]]);
  });

  test("keeps the server's overflow count and never changes its input", () => {
    const server = { items: [bubble("a", 1)], more: 4 };
    const before = JSON.stringify(server);
    assert.equal(mergeBubbles(server, ["b"])?.more, 4);
    assert.equal(JSON.stringify(server), before);
  });

  test("two of my answers that mean the same thing are added once", () => {
    const merged = mergeBubbles(undefined, ["Pizza", " pizza "]);
    assert.equal(merged?.items.length, 1);
  });

  test("carries only text and counts: no names anywhere", () => {
    const merged = mergeBubbles({ items: [bubble("DATA", 2)], more: 0 }, ["x"]);
    for (const item of merged!.items) assert.deepEqual(Object.keys(item).sort(), ["count", "key", "text"]);
  });
});
