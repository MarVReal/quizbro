export type QuestionType =
  | "multiple_choice"
  | "multiple_select"
  | "true_false"
  | "short_text"
  | "poll";

export type ThemeId = "grape" | "sunset" | "ocean" | "mint" | "candy";

export const QUESTION_TYPES: {
  id: QuestionType;
  label: string;
  emoji: string;
  hint: string;
}[] = [
  { id: "multiple_choice", label: "Multiple choice", emoji: "🎯", hint: "One right answer" },
  { id: "multiple_select", label: "Select all", emoji: "✅", hint: "Several right answers" },
  { id: "true_false", label: "True / False", emoji: "⚖️", hint: "Quick fire" },
  { id: "short_text", label: "Type answer", emoji: "⌨️", hint: "Players type it in" },
  { id: "poll", label: "Poll", emoji: "📊", hint: "No right answer, no points" },
];

/** A question as edited in the builder. */
export interface DraftQuestion {
  uid: string;
  type: QuestionType;
  prompt: string;
  image_url: string;
  options: string[];
  /** Indexes of correct options (choice types). */
  correct: number[];
  /** Accepted answers (short_text). */
  accepted: string[];
  time_limit: number;
  points: number;
}

export interface QuizPublic {
  id: string;
  code: string;
  title: string;
  description: string | null;
  theme: ThemeId;
  question_count: number;
}

export interface PlayQuestion {
  id: string;
  pos: number;
  type: QuestionType;
  prompt: string;
  image_url: string | null;
  options: string[];
  time_limit: number;
  points: number;
}

export type NextQuestion =
  | { done: true; total: number; score: number }
  | {
      done: false;
      total: number;
      score: number;
      seconds_left: number;
      question: PlayQuestion;
    };

export interface SubmitResult {
  is_correct: boolean | null;
  points: number;
  timed_out: boolean;
  correct: number[] | string[] | null;
}

export interface LeaderboardRow {
  name: string;
  score: number;
  rank: number;
  is_me: boolean;
}

export interface ReviewRow {
  pos: number;
  prompt: string;
  type: QuestionType;
  options: string[];
  correct: number[] | string[] | null;
  answer: number[] | string | null;
  is_correct: boolean | null;
  points: number;
}

export interface Results {
  quiz: { title: string; code: string; theme: ThemeId };
  name: string;
  score: number;
  rank: number;
  correct: number;
  player_count: number;
  leaderboard: LeaderboardRow[];
  review: ReviewRow[];
}

export interface HostPlayer {
  id: string;
  name: string;
  score: number;
  answered: number;
  correct: number;
  last_active: string | null;
}

export interface HostQuestion {
  id: string;
  pos: number;
  type: QuestionType;
  prompt: string;
  options: string[];
  time_limit: number;
  points: number;
  correct: number[] | string[];
  answered: number;
  right: number;
  avg_time_ms: number | null;
  counts: number[] | null;
  texts: { text: string; count: number; is_correct: boolean }[] | null;
}

export interface HostDashboard {
  quiz: {
    id: string;
    code: string;
    title: string;
    description: string | null;
    theme: ThemeId;
  };
  question_count: number;
  players: HostPlayer[];
  questions: HostQuestion[];
}
