// Pure helpers for multi-answer questions. No imports, so it also runs under `node --test`.
// The server enforces the same rules in quizbro_clean_answers() / quizbro_norm()
// (supabase/migrations/20261005000000_multi_answer.sql); keep the two in sync.

export const MAX_ANSWERS = { min: 1, max: 20, default: 3 } as const;
export const MAX_CHARS = { min: 1, max: 200, default: 40 } as const;

/** Most bubbles the server returns (the rest are summarised as "+N more"). */
export const BUBBLE_CAP = 50;

/**
 * Seconds a player waits between answers. The server enforces it (with half a second of slack):
 * keep in sync with quizbro_answer_cooldown() in supabase/migrations.
 */
export const ANSWER_COOLDOWN_S = 3;

/** Trim and collapse runs of whitespace: what is stored and shown. */
export function cleanAnswer(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Merge key: two answers with the same key are the same bubble ("Pizza" = " pizza "). */
export function normalizeAnswer(s: string): string {
  return cleanAnswer(s).toLowerCase();
}

/** Length in characters (code points), matching Postgres' char_length. Not UTF-16 units. */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line @typescript-eslint/no-unused-vars
  return n;
}

interface BubbleLike {
  items: { key: string; text: string; count: number }[];
  more: number;
}

/**
 * The bubbles to show right after I send an answer: the server's merged bubbles, plus any of my own
 * answers the server hasn't counted yet (so I see mine appear instantly, before the next refresh).
 * Anonymous: only text and counts, never who sent what.
 */
export function mergeBubbles<T extends BubbleLike>(server: T | null | undefined, mine: string[]): BubbleLike | undefined {
  if (!server && mine.length === 0) return undefined;
  const items = [...(server?.items ?? [])];
  const have = new Set(items.map((i) => i.key));
  for (const text of mine) {
    const key = normalizeAnswer(text);
    if (have.has(key)) continue;
    have.add(key);
    items.push({ key, text: cleanAnswer(text), count: 1 });
  }
  return { items, more: server?.more ?? 0 };
}

export interface AnswerLimits {
  maxAnswers: number;
  maxChars: number;
}

export type NextAnswerCheck = { ok: true; answer: string } | { ok: false; error: string };

/**
 * Checks the next answer a player wants to send, given what they already sent. Same rules
 * (and wording) as the server: not blank, short enough, not one they already gave.
 */
export function validateNextAnswer(raw: string, mine: string[], limits: AnswerLimits): NextAnswerCheck {
  if (mine.length >= limits.maxAnswers) return { ok: false, error: "You have used all your answers" };
  const answer = cleanAnswer(raw);
  if (answer === "") return { ok: false, error: "Type an answer first" };
  if (charCount(answer) > limits.maxChars) {
    return { ok: false, error: `Keep each answer to ${limits.maxChars} characters or fewer` };
  }
  const key = normalizeAnswer(answer);
  if (mine.some((m) => normalizeAnswer(m) === key)) return { ok: false, error: "You already gave that answer" };
  return { ok: true, answer };
}

/** Clamp a possibly-garbage number into a range (used by the creator's steppers). */
export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
