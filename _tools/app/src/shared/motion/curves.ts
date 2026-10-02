/** Same 41 samples and endpoint as motion-2026-10-02.html (omega = 8). */
export const EASE_SHEET = 'cubic-bezier(.32,.72,0,1)';
export const EASE_STANDARD = 'cubic-bezier(0.2, 0, 0, 1)';
export const SPRING_FALLBACK = 'cubic-bezier(.22,1,.36,1)';
export const EASE_SPRING = `linear(${Array.from({length: 41}, (_, i) => {
  const u = i / 40;
  return (u >= 1 ? 1 : 1 - (1 + 8 * u) * Math.exp(-8 * u)).toFixed(4);
}).join(', ')})`;

export function springEasing() {
  return globalThis.CSS?.supports?.('transition-timing-function', 'linear(0, 1)') ? EASE_SPRING : SPRING_FALLBACK;
}

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
