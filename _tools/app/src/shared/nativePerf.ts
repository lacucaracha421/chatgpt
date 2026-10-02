/** Enabled only while the native measurement kit is installed. Never includes media IDs or URLs. */
export function nativePerfEnabled(): boolean {
  return typeof window !== "undefined" && Boolean((window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf)
    && typeof performance.mark === "function" && typeof performance.measure === "function";
}

let sequence = 0;
export function beginNativePhase(name: string) {
  if (!nativePerfEnabled()) return null;
  const start = `w4:${name}:${++sequence}:start`;
  performance.mark(start);
  const finished = new Set<string>();
  let cancelled = false;
  const mark = (phase: string) => {
    if (cancelled || finished.has(phase)) return;
    finished.add(phase);
    performance.measure(`w4:${name}.${phase}`, start);
  };
  return {
    mark,
    // Two frame boundaries approximate a paint opportunity, not compositor acknowledgement.
    afterPaint(phase: string) {
      let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => mark(phase)); });
      return () => cancelAnimationFrame(frame);
    },
    cancel() { cancelled = true; performance.clearMarks(start); },
  };
}
