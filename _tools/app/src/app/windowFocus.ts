/** Share the DOM focus signal already used by the PC sync hooks. WebKitGTK
 * can keep document.visibilityState visible even while the window is minimized. */
const subscribers = new Set<() => void>();
let focused = false;
const onFocus = () => { focused = true; subscribers.forEach(notify => notify()); };
const onBlur = () => { focused = false; subscribers.forEach(notify => notify()); };

export function isWindowFocused() {
  return subscribers.size ? focused : document.hasFocus();
}

export function subscribeWindowFocus(notify: () => void) {
  if (!subscribers.size) {
    focused = document.hasFocus();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
  }
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (!subscribers.size) {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    }
  };
}

export function windowPollDelay(normal: number) {
  return isWindowFocused() ? normal : Math.max(60_000, normal);
}
