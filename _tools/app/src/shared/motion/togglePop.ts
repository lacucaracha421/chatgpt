import { EASE_STANDARD, reducedMotion } from "./curves";

const HOST_CLASS = "toggle-pop-host";
const BURST_CLASS = "toggle-pop-burst";
const DOT_CLASS = "toggle-pop-dot";
const OVERSHOOT = "cubic-bezier(.34,1.56,.64,1)";
const DOT_COUNT = 6;
/** A toggle whose state has not flipped by then failed or was abandoned: no pop. */
const WAIT_MS = 5000;

const running = new WeakMap<HTMLElement, () => void>();

/**
 * The shared pop for favorite, bookmark and showcase toggles, called from the user's own
 * click, tap or shortcut. The pop waits until the button's `aria-pressed` shows `on`, so an
 * optimistic toggle plays it on its next commit and a saved one when the save lands; a failed
 * toggle never pops. A button showing different items marks the item in `data-toggle-key`:
 * a key change before the flip (the viewer moved on) drops the pop. Turning on squashes,
 * overshoots and settles the icon with a small burst in the on colour; turning off only dips.
 * Reduced motion, missing Web Animations or a detached button leave just the state change.
 */
export function popToggle(button: HTMLElement, on: boolean): void {
  try {
    running.get(button)?.();
    if (!button.isConnected || typeof button.animate !== "function" || reducedMotion()) return;
    const key = button.dataset.toggleKey;
    let animations: Animation[] = [];
    let burst: HTMLElement | null = null;
    let hosted = false;
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      observer?.disconnect();
      clearTimeout(timer);
      burst?.remove();
      burst = null;
      if (hosted) button.classList.remove(HOST_CLASS);
      hosted = false;
      if (running.get(button) === stop) running.delete(button);
    };
    const stop = () => {
      const current = animations;
      animations = [];
      for (const animation of current) {
        try { animation.cancel(); } catch { /* already gone */ }
      }
      finish();
    };
    running.set(button, stop);
    const start = () => { try { play(); } catch { stop(); } };
    const play = () => {
      if (!button.isConnected) { finish(); return; }
      const icon = (button.querySelector("svg") as Element | null) ?? button;
      if (!on) {
        animations = [icon.animate([{ scale: 1 }, { scale: 0.88 }, { scale: 1 }], { duration: 180, easing: EASE_STANDARD })];
      } else {
        const spring = getComputedStyle(button).getPropertyValue("--spring-gentle").trim() || OVERSHOOT;
        animations = [icon.animate([
          { scale: 1, offset: 0 }, { scale: 0.82, offset: 0.25 }, { scale: 1.22, offset: 0.6 }, { scale: 1, offset: 1 },
        ], { duration: 420, easing: spring })];
        if (getComputedStyle(button).position === "static") {
          button.classList.add(HOST_CLASS);
          hosted = true;
        }
        const host = button.getBoundingClientRect();
        const glyph = icon.getBoundingClientRect();
        const x = glyph.left + glyph.width / 2 - host.left - button.clientLeft;
        const y = glyph.top + glyph.height / 2 - host.top - button.clientTop;
        burst = document.createElement("span");
        burst.className = BURST_CLASS;
        burst.setAttribute("aria-hidden", "true");
        button.append(burst);
        for (let index = 0; index < DOT_COUNT; index += 1) {
          const dot = document.createElement("span");
          dot.className = DOT_CLASS;
          dot.style.left = `${x}px`;
          dot.style.top = `${y}px`;
          burst.append(dot);
          const angle = (index / DOT_COUNT) * 2 * Math.PI - Math.PI / 2;
          const distance = index % 2 ? 14 : 16;
          const dx = (Math.cos(angle) * distance).toFixed(2);
          const dy = (Math.sin(angle) * distance).toFixed(2);
          animations.push(dot.animate([
            { transform: "translate(-50%, -50%) translate(0px, 0px) scale(1)", opacity: 1 },
            { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 },
          ], { duration: 380, easing: EASE_STANDARD, fill: "forwards" }));
        }
      }
      let pending = animations.length;
      for (const animation of animations) {
        animation.onfinish = () => { pending -= 1; if (pending === 0) finish(); };
        animation.oncancel = stop;
      }
    };
    const pressed = button.getAttribute("aria-pressed");
    if (pressed === null || pressed === String(on)) { start(); return; }
    observer = new MutationObserver(() => {
      if (!button.isConnected || button.dataset.toggleKey !== key) { stop(); return; }
      if (button.getAttribute("aria-pressed") !== String(on)) return;
      observer?.disconnect();
      clearTimeout(timer);
      start();
    });
    observer.observe(button, { attributes: true, attributeFilter: ["aria-pressed", "data-toggle-key"] });
    timer = setTimeout(stop, WAIT_MS);
  } catch {
    // Decoration only: the toggle itself already happened.
  }
}
