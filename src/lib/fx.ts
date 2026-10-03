import confetti from "canvas-confetti";

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function buzz(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}

export function popConfetti() {
  if (reduced()) return;
  confetti({
    particleCount: 70,
    spread: 70,
    startVelocity: 38,
    origin: { y: 0.75 },
    disableForReducedMotion: true,
  });
}

export function bigConfetti() {
  if (reduced()) return;
  const end = Date.now() + 1800;
  const colors = ["#ffd23f", "#ef476f", "#06a77d", "#118ab2", "#ffffff"];
  (function frame() {
    confetti({ particleCount: 5, angle: 60, spread: 60, origin: { x: 0 }, colors });
    confetti({ particleCount: 5, angle: 120, spread: 60, origin: { x: 1 }, colors });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}
