import { useLayoutEffect, type RefObject } from "react";
import { beginNativePhase } from "../shared/nativePerf";

/** Observe the first visible front cover only; no listeners, reads or decoding outside the kit. */
export function useCollectionCoverPerf(rootRef: RefObject<HTMLElement | null>, scope: string, items: unknown) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const phase = beginNativePhase("collections.list-to-first-cover");
    if (!phase) return;
    let cancelled = false, picked = false;
    let cancelPaint: (() => void) | undefined;
    const check = () => {
      if (picked || cancelled) return;
      const bounds = root.getBoundingClientRect();
      const image = [...root.querySelectorAll<HTMLImageElement>(".cs-front img, .collection-card__cover img")].find(img => {
        if (!img.complete || !img.naturalWidth || getComputedStyle(img).visibility === "hidden") return false;
        const rect = img.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top && rect.top < Math.min(bounds.bottom, innerHeight);
      });
      if (!image) return;
      picked = true;
      phase.mark("loaded");
      void Promise.resolve(image.decode?.()).then(() => {
        if (cancelled || !image.isConnected) return;
        phase.mark("decoded");
        cancelPaint = phase.afterPaint("visible");
      }, () => { picked = false; });
    };
    root.addEventListener("load", check, true);
    const observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "src"] });
    check();
    return () => { cancelled = true; cancelPaint?.(); observer.disconnect(); root.removeEventListener("load", check, true); phase.cancel(); };
  }, [rootRef, scope, items]);
}
