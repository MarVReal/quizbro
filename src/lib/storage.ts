// Small localStorage helpers. Storage can be unavailable (private mode, blocked
// cookies), so every access is wrapped and the app works without it.

export interface MyQuiz {
  id: string;
  code: string;
  title: string;
  hostToken: string;
  createdAt: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function getMyQuizzes(): MyQuiz[] {
  return read<MyQuiz[]>("quizbro:mine", []);
}

export function saveMyQuiz(quiz: MyQuiz) {
  const rest = getMyQuizzes().filter((q) => q.id !== quiz.id);
  write("quizbro:mine", [quiz, ...rest].slice(0, 30));
}

export function forgetMyQuiz(id: string) {
  write(
    "quizbro:mine",
    getMyQuizzes().filter((q) => q.id !== id),
  );
}

export const getPlayerId = (code: string) =>
  read<string | null>(`quizbro:player:${code.toUpperCase()}`, null);

export const savePlayerId = (code: string, id: string) =>
  write(`quizbro:player:${code.toUpperCase()}`, id);

export const clearPlayerId = (code: string) => {
  try {
    localStorage.removeItem(`quizbro:player:${code.toUpperCase()}`);
  } catch {
    /* ignore */
  }
};

export const getPlayerName = () => read<string>("quizbro:name", "");
export const savePlayerName = (name: string) => write("quizbro:name", name);

export const getDraft = <T,>() => read<T | null>("quizbro:draft", null);
export const saveDraft = (draft: unknown) => write("quizbro:draft", draft);
export const clearDraft = () => {
  try {
    localStorage.removeItem("quizbro:draft");
  } catch {
    /* ignore */
  }
};
