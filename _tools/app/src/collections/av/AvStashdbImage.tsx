import { useEffect, useRef, useState } from "react";
import type { AvGateway } from "../avTypes";
import { StableImage } from "../../shared/ui/StableImage";

// Candidate and portrait grids share one queue per frontend. The native relay
// serializes downloads across windows, including selected-photo previews.
let previewLane: Promise<unknown> = Promise.resolve();
export function AvStashdbImage({ url, routed, api, onError }: { url: string; routed: boolean; api: AvGateway; onError(reason: unknown): void }) {
  const [source, setSource] = useState<string | null>(null);
  const host = useRef<HTMLSpanElement>(null);
  const error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    if (!routed) return;
    let active = true;
    let requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      previewLane = previewLane.catch(() => {}).then(async () => {
        if (!active) return;
        try {
          const next = await api.previewStashdbImage(url);
          if (active) setSource(next);
        } catch (reason) { if (active) error.current(reason); }
      });
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
