import { useLayoutEffect, useState, type RefObject } from "react";

/** Keep decoded spines mounted; request the next art windows just before they enter the strip. */
export function useSpineImages(viewport: RefObject<HTMLDivElement | null>, enabled: boolean, volumes: readonly { id: string }[], sampleId?: string) {
  const [requested, setRequested] = useState<Set<string> | null>(() => enabled ? new Set(sampleId ? [sampleId] : []) : null);
  const [measured, setMeasured] = useState<typeof volumes | null>(null);
  useLayoutEffect(() => {
    const track = viewport.current?.querySelector<HTMLElement>(".home-shelf__track");
    if (!enabled || !track || typeof IntersectionObserver === "undefined") {
      setRequested(null); setMeasured(volumes); return;
    }
    const box = track.getBoundingClientRect();
    if (!box.width) { setRequested(null); setMeasured(volumes); return; }
    const buttons = [...track.querySelectorAll<HTMLElement>("button[data-volume-id]")];
    // One short look-ahead on each side, measured after the selected spine was scrolled into view.
    const margin = 128;
    const initial = buttons.filter(button => {
      const spine = button.getBoundingClientRect();
      return spine.right >= box.left - margin && spine.left <= box.right + margin;
    }).map(button => button.dataset.volumeId!);
    if (sampleId) initial.push(sampleId);
    setRequested(previous => new Set([...previous ?? [], ...initial]));
    setMeasured(volumes);
    const observer = new IntersectionObserver(entries => {
      const entering = entries.filter(entry => entry.isIntersecting).map(entry => {
        observer.unobserve(entry.target);
        return (entry.target as HTMLElement).dataset.volumeId!;
      });
      if (!entering.length) return;
      setRequested(previous => entering.every(id => previous?.has(id)) ? previous : new Set([...previous ?? [], ...entering]));
    }, { root: track, rootMargin: `0px ${margin}px` });
    for (const button of buttons) observer.observe(button);
    return () => observer.disconnect();
  }, [viewport, enabled, volumes, sampleId]);
  return { requested, measured: measured === volumes };
}
