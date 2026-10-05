// Pure helpers for multi-answer questions. No imports, so it also runs under `node --test`.
// The server enforces the same rules in quizbro_clean_answers() / quizbro_norm()
// (supabase/migrations/20261005000000_multi_answer.sql); keep the two in sync.

export const MAX_ANSWERS = { min: 1, max: 20, default: 3 } as const;
export const MAX_CHARS = { min: 1, max: 200, default: 40 } as const;

/** Most bubbles the server returns (the rest are summarised as "+N more"). */
export const BUBBLE_CAP = 50;

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

export interface AnswerLimits {
  maxAnswers: number;
  maxChars: number;
}

export type AnswerCheck =
  | { ok: true; answers: string[] }
  | { ok: false; error: string; /** index of the offending input, when there is one */ index?: number };

/**
 * Validates a submission exactly like the server does: trimmed, no blanks, no
 * case-insensitive duplicates, within the count and length limits.
 */
export function validateAnswers(raw: string[], limits: AnswerLimits): AnswerCheck {
  const { maxAnswers, maxChars } = limits;
  if (raw.length === 0) return { ok: false, error: "Add at least one answer" };
  if (raw.length > maxAnswers) {
    return { ok: false, error: `You can give up to ${maxAnswers} answer${maxAnswers === 1 ? "" : "s"}` };
  }
  const seen = new Map<string, number>();
  const answers: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = cleanAnswer(raw[i]);
    if (a === "") return { ok: false, error: "Answers can't be blank", index: i };
    if (charCount(a) > maxChars) {
      return { ok: false, error: `Keep each answer to ${maxChars} characters or fewer`, index: i };
    }
    const key = normalizeAnswer(a);
    if (seen.has(key)) return { ok: false, error: "You entered the same answer twice", index: i };
    seen.set(key, i);
    answers.push(a);
  }
  return { ok: true, answers };
}

/** Clamp a possibly-garbage number into a range (used by the creator's steppers). */
export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
