import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cleanAnswer,
  charCount,
  clampInt,
  normalizeAnswer,
  salvageAnswers,
  validateAnswers,
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

describe("validateAnswers", () => {
  test("accepts and returns trimmed, space-collapsed answers in order", () => {
    const r = validateAnswers(["  Pizza ", "ta   cos"], limits);
    assert.deepEqual(r, { ok: true, answers: ["Pizza", "ta cos"] });
  });

  test("rejects an empty submission", () => {
    const r = validateAnswers([], limits);
    assert.equal(r.ok, false);
  });

  test("rejects blanks and whitespace-only answers, pointing at the input", () => {
    for (const blank of ["", "   ", "\t\n", "\u00a0"]) {
      const r = validateAnswers(["ok", blank], limits);
      assert.deepEqual(r, { ok: false, error: "Answers can't be blank", index: 1 });
    }
  });

  test("rejects case-insensitive duplicates and points at the second one", () => {
    const r = validateAnswers(["Pizza", "tacos", "PIZZA"], limits);
    assert.deepEqual(r, { ok: false, error: "You entered the same answer twice", index: 2 });
    assert.equal(validateAnswers(["a b", "A   B"], limits).ok, false);
  });

  test("enforces the max number of answers", () => {
    assert.equal(validateAnswers(["a", "b", "c"], limits).ok, true);
    const r = validateAnswers(["a", "b", "c", "d"], limits);
    assert.deepEqual(r, { ok: false, error: "You can give up to 3 answers" });
    assert.deepEqual(validateAnswers(["a", "b"], { maxAnswers: 1, maxChars: 10 }), {
      ok: false,
      error: "You can give up to 1 answer",
    });
  });

  test("enforces the max length exactly at the boundary", () => {
    assert.equal(validateAnswers(["x".repeat(10)], limits).ok, true);
    const r = validateAnswers(["x".repeat(11)], limits);
    assert.deepEqual(r, { ok: false, error: "Keep each answer to 10 characters or fewer", index: 0 });
  });

  test("length is measured after trimming and collapsing", () => {
    assert.equal(validateAnswers(["   " + "x".repeat(10) + "   "], limits).ok, true);
    assert.equal(validateAnswers(["a" + " ".repeat(30) + "b"], limits).ok, true); // becomes "a b"
  });

  test("emoji each count as one character", () => {
    assert.equal(validateAnswers(["🍕".repeat(10)], limits).ok, true);
    assert.equal(validateAnswers(["🍕".repeat(11)], limits).ok, false);
  });

  test("a very long single word is rejected rather than truncated", () => {
    const r = validateAnswers(["supercalifragilisticexpialidocious"], limits);
    assert.equal(r.ok, false);
  });

  test("reports the first problem when several exist", () => {
    const r = validateAnswers(["", "x".repeat(50)], limits);
    assert.deepEqual(r, { ok: false, error: "Answers can't be blank", index: 0 });
  });
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

describe("salvageAnswers", () => {
  test("keeps usable answers and drops blanks, duplicates and over-long ones", () => {
    const r = salvageAnswers(["Pizza", "", "pizza", "x".repeat(40), "  tacos "], { maxAnswers: 5, maxChars: 10 });
    assert.deepEqual(r, ["Pizza", "tacos"]);
  });
  test("never returns more than the answer limit", () => {
    assert.deepEqual(salvageAnswers(["a", "b", "c", "d"], { maxAnswers: 2, maxChars: 10 }), ["a", "b"]);
  });
  test("returns nothing when nothing is usable", () => {
    assert.deepEqual(salvageAnswers(["", "  "], limits), []);
  });
  test("its output always passes validateAnswers", () => {
    const out = salvageAnswers(["A", "a", "", "b ", "ccccccccccccc"], limits);
    assert.equal(validateAnswers(out, limits).ok, true);
  });
});
