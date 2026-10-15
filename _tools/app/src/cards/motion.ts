import { useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";
const snapshot = () => typeof matchMedia === "function" && matchMedia(query).matches;
const subscribe = (change: () => void) => {
  const media = typeof matchMedia === "function" ? matchMedia(query) : null;
  media?.addEventListener("change", change);
  return () => media?.removeEventListener("change", change);
};
export const useCardReducedMotion = () => useSyncExternalStore(subscribe, snapshot, () => false);

/** Latest pointer wins; leaving/unmounting cancels the pending frame. */
export function createPointerTilt(element: HTMLElement, reduced: boolean) {
  let frame = 0, x = 0, y = 0;
  const reset = () => {
    cancelAnimationFrame(frame); frame = 0;
    element.classList.remove("active", "hov");
    ["--mx", "--my", "--rx", "--ry", "--ang", "--o", "--dx", "--dy", "--px", "--py", "--tx", "--ty", "--po"].forEach(key => element.style.removeProperty(key));
  };
  return {
    move(clientX: number, clientY: number) {
      if (reduced) return;
      x = clientX; y = clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
        const py = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
        element.classList.add("active", "hov");
        const values = { "--mx": `${px * 100}%`, "--my": `${py * 100}%`, "--rx": `${(py - .5) * -28}deg`, "--ry": `${(px - .5) * 28}deg`, "--ang": `${px * 180 - 90}deg`, "--o": ".85", "--dx": `${px - .5}`, "--dy": `${py - .5}`, "--px": `${px * 100}%`, "--py": `${py * 100}%`, "--tx": `${px - .5}`, "--ty": `${py - .5}`, "--po": "1" };
        Object.entries(values).forEach(([key, value]) => element.style.setProperty(key, value));
      });
    }, reset,
  };
}

/** Each opening owns its animations and waits: skip/unmount never touches the host app. */
export class CardSequence {
  private cancelled = false;
  private finishes = new Set<() => void>();
  constructor(readonly reduced: boolean) {}
  get stopped() { return this.cancelled; }
  stop() { this.cancelled = true; this.finishes.forEach(finish => finish()); this.finishes.clear(); }
  wait(ms: number) {
    return new Promise<void>(resolve => {
      if (this.cancelled) { resolve(); return; }
      const finish = () => { clearTimeout(timer); this.finishes.delete(finish); resolve(); };
      const timer = setTimeout(finish, ms);
      this.finishes.add(finish);
    });
  }
  animate(element: HTMLElement, frames: Keyframe[], duration: number, delay = 0) {
    return new Promise<void>(resolve => {
      if (this.cancelled) { resolve(); return; }
      if (!element.animate) { resolve(); return; }
      const keyframes: Keyframe[] = this.reduced ? frames.map(frame => ({ opacity: frame.opacity ?? 1 })) : frames;
      const animation = element.animate(keyframes, { duration: this.reduced ? 180 : duration, delay: this.reduced ? 0 : delay, fill: "both", easing: "cubic-bezier(.22,.7,.3,1)" });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer); this.finishes.delete(finish);
        if (!this.cancelled) {
          const last = keyframes[keyframes.length - 1];
          if (last.transform !== undefined) element.style.transform = String(last.transform);
          if (last.opacity !== undefined) element.style.opacity = String(last.opacity);
        }
        animation.cancel(); resolve();
      };
      const timer = setTimeout(finish, (this.reduced ? 180 : duration + delay) + 120);
      this.finishes.add(finish);
      animation.finished.then(finish, finish);
    });
  }
}
