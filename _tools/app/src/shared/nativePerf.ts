let pcEnabled = false;
let phaseListener: ((name: string, phase: string, startMs: number) => void) | undefined;
export function configurePcPerf(enabled: boolean, listener?: typeof phaseListener) {
  pcEnabled = enabled;
  phaseListener = listener;
}

/** Enabled by the native measurement kit or the opt-in PC log. Never includes media IDs or URLs. */
export function nativePerfEnabled(): boolean {
  return typeof window !== "undefined" && (pcEnabled || Boolean((window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf))
    && typeof performance.mark === "function" && typeof performance.measure === "function";
}

let sequence = 0;
export function beginNativePhase(name: string, startMs?: number) {
  if (!nativePerfEnabled()) return null;
  const start = `w4:${name}:${++sequence}:start`;
  const at = startMs ?? performance.now();
  try { if (startMs === undefined) performance.mark(start); else performance.mark(start, { startTime: startMs }); } catch { return null; }
  const finished = new Set<string>();
  let cancelled = false;
  const mark = (phase: string) => {
    if (cancelled || finished.has(phase)) return;
    finished.add(phase);
    try {
      performance.measure(`w4:${name}.${phase}`, start);
      phaseListener?.(name, phase, at);
    } catch { /* Timing never affects the app. */ }
  };
  return {
    mark,
    // Two frame boundaries approximate a paint opportunity, not compositor acknowledgement.
    afterPaint(phase: string) {
      let frame = 0;
      try { frame = requestAnimationFrame(() => { try { frame = requestAnimationFrame(() => mark(phase)); } catch { /* Timing only. */ } }); } catch { /* Timing only. */ }
      return () => { try { cancelAnimationFrame(frame); } catch { /* Timing only. */ } };
    },
    cancel() { cancelled = true; try { performance.clearMarks(start); } catch { /* Timing only. */ } },
  };
}
