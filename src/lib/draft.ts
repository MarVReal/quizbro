import type { DraftQuestion, QuestionType, ThemeId } from "./types";

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
  if (type === "poll") next.points = 0;
  else if (q.type === "poll" || next.points === 0) next.points = 1000;
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
