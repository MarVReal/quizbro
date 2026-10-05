import type { FeedItem } from "./multi-answer";

export type { FeedItem };

export type QuestionType =
  | "multiple_choice"
  | "multiple_select"
  | "true_false"
  | "short_text"
  | "poll"
  | "multi_answer";

/** Question types with no right answer: no key, no points, no leaderboard impact. */
export const isUnscored = (type: QuestionType) => type === "poll" || type === "multi_answer";

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
  {
    id: "multi_answer",
    label: "Multi-answer",
    emoji: "🫧",
    hint: "Everyone types a few answers; matching ones merge into live bubbles",
  },
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
  /** multi_answer only: how many answers one person may give, and how long each can be. */
  max_answers: number;
  max_chars: number;
}

export type GameStatus = "lobby" | "question" | "reveal" | "finished";

export interface QuizPublic {
  id: string;
  code: string;
  title: string;
  description: string | null;
  theme: ThemeId;
  status: GameStatus;
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
  /** multi_answer only. */
  max_answers?: number;
  max_chars?: number;
}

/** One merged answer: everybody who typed the same thing (ignoring case/spacing) shares a bubble. */
export interface BubbleItem {
  key: string;
  text: string;
  count: number;
}

export interface BubbleData {
  items: BubbleItem[];
  /** Unique answers left out because of the cap. */
  more: number;
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
  answer: number[] | string | string[] | null;
  is_correct: boolean | null;
  points: number;
}

export interface RevealInfo {
  /** Correct answer(s); null for polls and multi-answer. */
  correct: number[] | string[] | null;
  /** null for polls and multi-answer. */
  is_correct: boolean | null;
  points: number;
  answered: boolean;
  my_answer: number[] | string | string[] | null;
}

/** Everything a phone needs for the current moment of the game. */
export interface PlayState {
  status: GameStatus;
  quiz: { title: string; code: string; theme: ThemeId; question_count: number };
  name: string;
  player_count: number;
  streak: number;
  score: number;
  rank: number | null;
  correct: number;
  leaderboard: LeaderboardRow[];
  /** Lobby only: names of who has joined. */
  players?: string[];
  /** question + reveal */
  question?: PlayQuestion;
  seconds_left?: number;
  closed?: boolean;
  answered?: boolean;
  answered_count?: number;
  reveal?: RevealInfo;
  /** multi_answer: shown once you have submitted (and on reveal). */
  bubbles?: BubbleData;
  /** multi_answer: the live chat of answers (who said what), oldest first. Same visibility as `bubbles`. */
  feed?: FeedItem[];
  /** multi_answer: what you submitted (so your bubbles stay highlighted after a refresh). */
  my_answers?: string[] | null;
  /** multi_answer: seconds until you may send your next answer (0 = go ahead). */
  cooldown_left?: number;
  /** finished */
  review?: ReviewRow[];
}

export interface HostPlayer {
  id: string;
  name: string;
  score: number;
  answered: number;
  correct: number;
  last_active: string | null;
  answered_current: boolean;
}

export interface HostQuestion {
  id: string;
  pos: number;
  type: QuestionType;
  prompt: string;
  image_url: string | null;
  options: string[];
  time_limit: number;
  points: number;
  correct: number[] | string[];
  answered: number;
  right: number;
  avg_time_ms: number | null;
  counts: number[] | null;
  texts: { text: string; count: number; is_correct: boolean }[] | null;
  max_answers: number;
  max_chars: number;
  /** multi_answer only. */
  bubbles: BubbleData | null;
  /** multi_answer: the live chat, for the question on screen only (null otherwise). */
  feed: FeedItem[] | null;
}

export interface HostDashboard {
  quiz: {
    id: string;
    code: string;
    title: string;
    description: string | null;
    theme: ThemeId;
  };
  state: {
    status: GameStatus;
    /** 1-based position of the current question (0 in the lobby). */
    current_pos: number;
    seconds_left: number;
    /** True once the timer has ended (or the answer is revealed). */
    closed: boolean;
  };
  question_count: number;
  players: HostPlayer[];
  questions: HostQuestion[];
}

export type HostAction = "start" | "close" | "reveal" | "next" | "reset";
