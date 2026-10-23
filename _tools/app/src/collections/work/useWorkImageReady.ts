import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

/** Readiness of the actual case/strip/shelf elements, after their decoded paint commits. */
export function useWorkImageReady(sources: Record<string, string | null>, onReady?: () => void) {
  const signature = JSON.stringify(sources);
  const requested = useRef({
    signature, sources,
    generations: Object.fromEntries(Object.keys(sources).map(key => [key, 0])),
    settled: {} as Record<string, string>,
    pending: new Set(Object.keys(sources).filter(key => sources[key])),
  });
  if (requested.current.signature !== signature) {
    const previous = requested.current;
    const generations = { ...previous.generations };
    for (const key of new Set([...Object.keys(generations), ...Object.keys(sources)])) {
      generations[key] = (generations[key] ?? 0) + (previous.sources[key] === sources[key] ? 0 : 1);
    }
    const settled = Object.fromEntries(Object.entries(previous.settled).filter(([key, src]) => sources[key] === src && previous.sources[key] === src));
    const pending = new Set(Object.keys(sources).filter(key => sources[key] && settled[key] !== sources[key]));
    requested.current = { signature, sources, generations, settled, pending };
  }
  const current = requested.current;
  const [, update] = useState(0);
  const notify = useRef(onReady); notify.current = onReady;
  useEffect(() => {
    if (!current.pending.size) onReady?.();
  });
  return useMemo(() => {
    function settle(key: string, src: string) {
      const latest = requested.current;
      // Another image may join the work while this one decodes; only this key's changes cancel it.
      if (latest.generations[key] !== current.generations[key] || latest.sources[key] !== src || latest.settled[key] === src) return;
      latest.settled[key] = src;
      latest.pending.delete(key);
      // Intermediate images need no parent render. List shelves have no readiness consumer.
      if (!latest.pending.size && notify.current) update(value => value + 1);
    }
    async function loaded(key: string, event: SyntheticEvent<HTMLImageElement>) {
      const image = event.currentTarget, src = image.getAttribute("src");
      if (!src) return;
      if (!notify.current) { settle(key, src); return; }
      try { await image.decode?.(); } catch { /* An unavailable image must not block navigation. */ }
      if (image.isConnected && image.getAttribute("src") === src) settle(key, src);
    }
    return { loaded, failed: settle };
  }, [current]);
}
