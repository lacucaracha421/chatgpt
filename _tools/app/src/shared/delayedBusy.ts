export type BusyTiming = { delay?: number; minVisible?: number };

/** A single timer owns both edges; a resumed operation keeps an already visible label. */
export function createDelayedBusy(onChange: (visible: boolean) => void, { delay = 600, minVisible = 400 }: BusyTiming = {}) {
  let busy = false;
  let visible = false;
  let shownAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const show = () => { timer = undefined; visible = true; shownAt = Date.now(); onChange(true); };
  const hide = () => { timer = undefined; visible = false; onChange(false); };
  return {
    setBusy(next: boolean) {
      if (next === busy) return;
      busy = next;
      clear();
      if (busy) {
        if (!visible) timer = setTimeout(show, Math.max(0, delay));
      } else if (visible) {
        const remaining = minVisible - (Date.now() - shownAt);
        if (remaining > 0) timer = setTimeout(hide, remaining);
        else hide();
      }
    },
    dispose() { clear(); busy = false; visible = false; },
  };
}
