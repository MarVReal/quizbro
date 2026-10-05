import { MAX_ANSWERS, MAX_CHARS } from "./multi-answer";
import { isUnscored, type DraftQuestion, type QuestionType, type ThemeId } from "./types";

export interface Draft {
  title: string;
  description: string;
  theme: ThemeId;
  questions: DraftQuestion[];
}

export const TIME_CHOICES = [10, 15, 20, 30, 45, 60, 90];
export const POINT_CHOICES = [500, 1000, 1500, 2000];

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function blankQuestion(type: QuestionType = "multiple_choice"): DraftQuestion {
  const base: DraftQuestion = {
    uid: uid(),
    type,
    prompt: "",
    image_url: "",
    options: ["", "", "", ""],
    correct: [0],
    accepted: [""],
    time_limit: 20,
    points: 1000,
    max_answers: MAX_ANSWERS.default,
    max_chars: MAX_CHARS.default,
  };
  return changeType(base, type);
}

/** Switch a question's type while keeping as much of the user's work as possible. */
export function changeType(q: DraftQuestion, type: QuestionType): DraftQuestion {
  const next = { ...q, type };
  if (type === "true_false") {
    next.options = ["True", "False"];
    next.correct = q.correct.length ? [Math.min(q.correct[0], 1)] : [0];
  } else if (type === "short_text") {
    next.accepted = q.accepted.length ? q.accepted : [""];
  } else if (type === "multi_answer") {
    // No options and no key. Keep any options so switching back doesn't lose them.
    if (q.type === "true_false") next.options = ["", "", "", ""];
    next.correct = [];
    // Drafts saved before this type existed have no limits yet.
    next.max_answers = q.max_answers ?? MAX_ANSWERS.default;
    next.max_chars = q.max_chars ?? MAX_CHARS.default;
  } else {
    let opts = q.type === "true_false" ? ["", "", "", ""] : [...q.options];
    while (opts.length < 2) opts.push("");
    opts = opts.slice(0, 6);
    next.options = opts;
    if (type === "poll") {
      next.correct = [];
    } else if (type === "multiple_choice") {
      next.correct = q.correct.length ? [q.correct[0]] : [0];
    } else {
      next.correct = q.correct.length ? q.correct : [0];
    }
    next.correct = next.correct.filter((i) => i < opts.length);
    if (type !== "poll" && next.correct.length === 0) next.correct = [0];
  }
  if (isUnscored(type)) next.points = 0;
  else if (isUnscored(q.type) || next.points === 0) next.points = 1000;
  return next;
}

/** Returns a human-readable problem for the question, or null when it's valid. */
export function questionProblem(q: DraftQuestion): string | null {
  if (!q.prompt.trim()) return "Write the question";
  if (q.image_url.trim() && !/^https?:\/\//i.test(q.image_url.trim()))
    return "Image link must start with http:// or https://";
  if (q.type === "short_text") {
    return q.accepted.some((a) => a.trim()) ? null : "Add at least one accepted answer";
  }
  if (q.type === "multi_answer") {
    if (!Number.isInteger(q.max_answers) || q.max_answers < MAX_ANSWERS.min || q.max_answers > MAX_ANSWERS.max)
      return `Max answers must be ${MAX_ANSWERS.min}-${MAX_ANSWERS.max}`;
    if (!Number.isInteger(q.max_chars) || q.max_chars < MAX_CHARS.min || q.max_chars > MAX_CHARS.max)
      return `Max characters must be ${MAX_CHARS.min}-${MAX_CHARS.max}`;
    return null;
  }
  if (q.options.some((o) => !o.trim())) return "Fill in every answer option";
  if (q.type !== "poll" && q.correct.length === 0) return "Mark the correct answer";
  return null;
}

export function draftProblem(d: Draft): string | null {
  if (!d.title.trim()) return "Give your quiz a title";
  if (d.questions.length === 0) return "Add at least one question";
  for (let i = 0; i < d.questions.length; i++) {
    const p = questionProblem(d.questions[i]);
    if (p) return `Question ${i + 1}: ${p}`;
  }
  return null;
}
