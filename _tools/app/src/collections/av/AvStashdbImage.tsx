import { useEffect, useRef, useState } from "react";
import type { AvGateway } from "../avTypes";
import { StableImage } from "../../shared/ui/StableImage";

// Candidate and portrait grids share a few download lanes per frontend (the native relay
// keeps the same limit across windows, including selected-photo previews). Each photo costs
// several server round trips, so one lane at a time made a full grid take tens of seconds.
const PREVIEW_LANES = 3;
let running = 0;
const waiting: Array<() => void> = [];
async function enterLane() {
  if (running >= PREVIEW_LANES) await new Promise<void>(resolve => waiting.push(resolve));
  else running += 1;
}
function leaveLane() {
  const next = waiting.shift();
  if (next) next(); else running -= 1;
}
// Previews are small and immutable per photo, so re-opening a picker shows them at once.
const MAX_CACHED_PREVIEWS = 80;
const previewCache = new Map<string, string>();
function remember(url: string, source: string) {
  previewCache.delete(url);
  previewCache.set(url, source);
  if (previewCache.size > MAX_CACHED_PREVIEWS) previewCache.delete(previewCache.keys().next().value!);
}
export function AvStashdbImage({ url, routed, api, onError }: { url: string; routed: boolean; api: AvGateway; onError(reason: unknown): void }) {
  const [source, setSource] = useState<string | null>(() => previewCache.get(url) ?? null);
  const host = useRef<HTMLSpanElement>(null);
  const error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    if (!routed) return;
    let active = true;
    let requested = false;
    const cached = previewCache.get(url);
    if (cached) { setSource(cached); return; }
    const load = () => {
      if (requested) return;
      requested = true;
      void (async () => {
        await enterLane();
        try {
          if (!active) return;
          const next = await api.previewStashdbImage(url);
          remember(url, next);
          if (active) setSource(next);
        } catch (reason) { if (active) error.current(reason); }
        finally { leaveLane(); }
      })();
    };
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined" && host.current) {
      observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); } });
      observer.observe(host.current);
    } else load();
    return () => { active = false; observer?.disconnect(); };
  }, [api, url, routed]);
  if (!routed) return <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  return <span className="av-stashdb-image" ref={host}>{source && <StableImage src={source} alt="" />}</span>;
}
