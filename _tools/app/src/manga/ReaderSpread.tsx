import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

type Spread = { id: number; identity: string; content: ReactNode };

// Prepare the actual reader DOM; an offscreen Image cannot preserve its paint
// when a different, newly mounted element is shown by the WebView.
export function ReaderSpread({ identity, children }: { identity: string; children: ReactNode }) {
  const nextId = useRef(0);
  const targetId = useMemo(() => ++nextId.current, [identity]);
  const target: Spread = { id: targetId, identity, content: children };
  const [active, setActive] = useState(target);
  const [retiring, setRetiring] = useState<Spread | null>(null);
  const pending = active.id !== target.id ? target : null;
  const pendingElement = useRef<HTMLDivElement>(null);
  const displayed = useRef(active);
  displayed.current = active.id === target.id ? target : active;

  useLayoutEffect(() => {
    if (!pending) return;
    const element = pendingElement.current!;
    let current = true;
    let promotionFrame = 0;
    const images = [...element.querySelectorAll<HTMLImageElement>("img")];
    const prepare = async () => {
      if (!images.every(image => image.complete && image.naturalWidth > 0)) return;
      const decoded = await Promise.all(images.map(async image => {
        try {
          if (typeof image.decode === "function") await image.decode();
          return true;
        } catch {
          // Let this page's normal error/retry UI settle before promotion.
          if (current) image.dispatchEvent(new Event("error"));
          return false;
        }
      }));
      if (decoded.some(ready => !ready)) return;
      if (!current) return;
      cancelAnimationFrame(promotionFrame);
      promotionFrame = requestAnimationFrame(() => {
        if (!current) return;
        setRetiring(displayed.current);
        setActive(pending);
      });
    };
    images.forEach(image => image.addEventListener("load", prepare));
    void prepare();
    return () => {
      current = false;
      cancelAnimationFrame(promotionFrame);
      images.forEach(image => image.removeEventListener("load", prepare));
    };
  }, [targetId, active.id, children]);

  useEffect(() => {
    if (!retiring) return;
    let removalFrame = 0;
    const paintFrame = requestAnimationFrame(() => {
      removalFrame = requestAnimationFrame(() => setRetiring(previous => previous === retiring ? null : previous));
    });
    return () => { cancelAnimationFrame(paintFrame); cancelAnimationFrame(removalFrame); };
  }, [retiring]);

  return <div className="manga-viewer__buffers">{[retiring, displayed.current, pending]
    .filter((spread): spread is Spread => Boolean(spread))
    .map(spread => {
      const state = spread.id === active.id ? "active" : spread.id === pending?.id ? "pending" : "retiring";
      return <div key={spread.id} ref={state === "pending" ? pendingElement : undefined}
        className="manga-viewer__buffer" data-reader-buffer={state}
        aria-hidden={state !== "active" ? true : undefined} inert={state !== "active" ? true : undefined}>
        {spread.content}
      </div>;
    })}</div>;
}
