import { useEffect, useRef, useState, type SyntheticEvent } from "react";

/** Readiness of the actual case/strip/shelf elements, after their decoded paint commits. */
export function useWorkImageReady(sources: Record<string, string | null>, onReady?: () => void) {
  const signature = JSON.stringify(sources);
  const requested = useRef({
    signature, sources,
    generations: Object.fromEntries(Object.keys(sources).map(key => [key, 0])),
    settled: {} as Record<string, string>,
  });
  if (requested.current.signature !== signature) {
    const previous = requested.current;
    const generations = { ...previous.generations };
    for (const key of new Set([...Object.keys(generations), ...Object.keys(sources)])) {
      generations[key] = (generations[key] ?? 0) + (previous.sources[key] === sources[key] ? 0 : 1);
    }
    const settled = Object.fromEntries(Object.entries(previous.settled).filter(([key, src]) => sources[key] === src && previous.sources[key] === src));
    requested.current = { signature, sources, generations, settled };
  }
  const current = requested.current;
  const [, update] = useState(0);
  useEffect(() => {
    if (Object.entries(sources).every(([key, src]) => !src || current.settled[key] === src)) onReady?.();
  });
  function settle(key: string, src: string) {
    const latest = requested.current;
    // Another image may join the work while this one decodes; only this key's changes cancel it.
    if (latest.generations[key] !== current.generations[key] || latest.sources[key] !== src || latest.settled[key] === src) return;
    latest.settled[key] = src;
    update(value => value + 1);
  }
  async function loaded(key: string, event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget, src = image.getAttribute("src");
    if (!src) return;
    try { await image.decode?.(); } catch { /* An unavailable image must not block navigation. */ }
    if (image.isConnected && image.getAttribute("src") === src) settle(key, src);
  }
  return { loaded, failed: settle };
}
