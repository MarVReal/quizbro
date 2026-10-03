import type { ThemeId } from "./types";

export const THEMES: { id: ThemeId; label: string; swatch: string }[] = [
  { id: "grape", label: "Grape", swatch: "linear-gradient(135deg,#2b1055,#7597de)" },
  { id: "sunset", label: "Sunset", swatch: "linear-gradient(135deg,#4a1942,#ff9f1c)" },
  { id: "ocean", label: "Ocean", swatch: "linear-gradient(135deg,#021b3a,#1fd1c1)" },
  { id: "mint", label: "Mint", swatch: "linear-gradient(135deg,#073b3a,#a7e8bd)" },
  { id: "candy", label: "Candy", swatch: "linear-gradient(135deg,#3a0ca3,#ff8fab)" },
];

/** Answer button colours; paired with letters so colour is never the only cue. */
export const OPTION_STYLES = [
  { bg: "#ef476f", shadow: "#a8284a", letter: "A" },
  { bg: "#118ab2", shadow: "#0a5a77", letter: "B" },
  { bg: "#ffb703", shadow: "#b07f00", letter: "C" },
  { bg: "#06a77d", shadow: "#04694f", letter: "D" },
  { bg: "#8d5bd6", shadow: "#5b3591", letter: "E" },
  { bg: "#f77f00", shadow: "#a55400", letter: "F" },
] as const;

export function asTheme(value: string | null | undefined): ThemeId {
  return THEMES.some((t) => t.id === value) ? (value as ThemeId) : "grape";
}
