import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  DraftQuestion,
  HostAction,
  HostDashboard,
  PlayState,
  QuizPublic,
  ThemeId,
} from "./types";

let client: SupabaseClient | null = null;

function supabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "QuiSDDAD isn't connected to Supabase yet. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Random, unguessable token for the private host link. */
export function newHostToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createQuiz(input: {
  title: string;
  description: string;
  theme: ThemeId;
  hostToken: string;
  questions: DraftQuestion[];
}) {
  const questions = input.questions.map((q) => ({
    type: q.type,
    prompt: q.prompt.trim(),
    image_url: q.image_url.trim() || null,
    options: q.type === "short_text" ? [] : q.options.map((o) => o.trim()),
    correct:
      q.type === "short_text"
        ? q.accepted.map((a) => a.trim()).filter(Boolean)
        : q.type === "poll"
          ? []
          : q.correct,
    time_limit: q.time_limit,
    points: q.type === "poll" ? 0 : q.points,
  }));
  return rpc<{ id: string; code: string }>("create_quiz", {
    p_title: input.title,
    p_description: input.description,
    p_theme: input.theme,
    p_host_token: input.hostToken,
    p_questions: questions,
  });
}

export const getQuizPublic = (code: string) =>
  rpc<QuizPublic>("get_quiz_public", { p_code: code });

export const joinQuiz = (code: string, name: string) =>
  rpc<{ player_id: string; quiz_id: string; name: string }>("join_quiz", {
    p_code: code,
    p_name: name,
  });

export const getPlayState = (playerId: string) =>
  rpc<PlayState>("get_play_state", { p_player_id: playerId });

/** Locks in an answer. Whether it was right is only revealed by the host. */
export const submitAnswer = (
  playerId: string,
  questionId: string,
  answer: number[] | string,
) =>
  rpc<{ accepted: boolean }>("submit_answer", {
    p_player_id: playerId,
    p_question_id: questionId,
    p_answer: answer,
  });

export const hostDashboard = (quizId: string, hostToken: string) =>
  rpc<HostDashboard>("host_get_dashboard", {
    p_quiz_id: quizId,
    p_host_token: hostToken,
  });

export const hostAction = (quizId: string, hostToken: string, action: HostAction) =>
  rpc<{ ok: boolean }>("host_action", {
    p_quiz_id: quizId,
    p_host_token: hostToken,
    p_action: action,
  });
