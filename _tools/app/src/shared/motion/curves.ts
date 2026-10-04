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

/** Same sampled spring as the approved motion demo; CSS tokens are the runtime source. */
export function springLinear(response: number, damping: number, points = 40) {
  const w = 2 * Math.PI / response, wd = w * Math.sqrt(Math.max(0, 1 - damping * damping));
  const x = (t: number) => damping >= 1 ? 1 - (1 + w * t) * Math.exp(-w * t)
    : 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + damping * w / wd * Math.sin(wd * t));
  let time = 0;
  while (time < 3 && Math.abs(1 - x(time)) > .002) time += .005;
  return { easing: `linear(${Array.from({ length: points + 1 }, (_, i) => +x(time * i / points).toFixed(4)).join(', ')})`, duration: Math.round(time * 1000) };
}

const springs = { snappy: springLinear(.32, 1), gentle: springLinear(.46, .88) };
/** motion-demo-20261004: springLinear(.32, 1), settled within .002 at 435ms. */
export const SNAPPY_MS = springs.snappy.duration;
export const EASE_SNAPPY = springs.snappy.easing;

export function snappySpringEasing() {
  return globalThis.CSS?.supports?.('transition-timing-function', 'linear(0, 1)') ? EASE_SNAPPY : EASE_STANDARD;
}

export function reducedMotion() {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
}

export { reducedMotion as prefersReducedMotion };

export const motionDefaults = { micro: 120, small: 180, medium: 240, large: 340, toastExit: 130 };
export const contentCross = { enter: 180, exit: 90, reduced: 120, image: 150 };

export function motionTime(token: string, fallback: number, element: Element = document.documentElement) {
  const value = getComputedStyle(element).getPropertyValue(token).trim();
  return value ? (parseFloat(value) || fallback) * (value.endsWith('ms') ? 1 : 1000) : fallback;
}

export function motionSpring(kind: keyof typeof springs, element: Element = document.documentElement) {
  const style = getComputedStyle(element);
  return {
    duration: motionTime(`--spring-${kind}-ms`, springs[kind].duration, element),
    easing: style.getPropertyValue(`--spring-${kind}`).trim() || EASE_STANDARD,
  };
}
