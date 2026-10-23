import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { requestSpineBitmap, type SpineBitmap } from "./mangaSpineBitmaps";
import { spineBitmapKey, type SpineBitmapSpec } from "./mangaSpineBitmapCache";

export const MangaBitmapScale = createContext({ scale: 1, dpr: 1 });

/** The loading slot itself is decoded and revealed; no fresh <img> on promotion. */
export function MangaSpineBitmap({ spec, children, onReady, paperWhilePending = false }: {
  spec: SpineBitmapSpec; children: ReactNode; onReady?(ratio: number | null): void; paperWhilePending?: boolean;
}) {
  const density = useContext(MangaBitmapScale);
  const input = { ...spec, ...density };
  const key = spineBitmapKey(input);
  const [prepared, setPrepared] = useState<{ key: string; value: SpineBitmap } | null>(null);
  const [painted, setPainted] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const visible = useRef(false);
  const current = useRef(key); current.current = key;
  const value = prepared?.key === key ? prepared.value : null;
  const ready = Boolean(value && painted === key);
  useEffect(() => {
    // Returning to a formerly painted key still changes this slot's source: decode it again.
    setPainted(null);
    setFailed(null);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => { visible.current = entries[0]?.isIntersecting ?? false; });
    if (image.current) observer?.observe(image.current.parentElement!);
    let live = true;
    const cancel = requestSpineBitmap(input, {
      priority: () => visible.current ? 0 : 1,
      done: value => { if (live) setPrepared({ key, value }); },
      failed: () => { if (live) setFailed(key); },
    });
    return () => { live = false; cancel(); observer?.disconnect(); };
    // The key contains every rendering input; input is intentionally not an effect dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const decoded = async (event: SyntheticEvent<HTMLImageElement>) => {
    const element = event.currentTarget;
    try { await element.decode(); } catch { if (current.current === key) setFailed(key); return; }
    if (element.isConnected && current.current === key && element.getAttribute("src") === value?.url) {
      onReady?.(value.ratio);
      setPainted(key);
    }
  };
  return <>
    {!ready && (paperWhilePending && failed !== key
      ? <span className="manga-spine-strip" aria-hidden="true" style={{ background: input.privacy ? "#f4f1e9" : input.ink }} />
      : children)}
    <img ref={image} className="manga-spine-strip manga-spine-bitmap" src={value?.url} alt="" aria-hidden="true" draggable={false}
      onLoad={decoded} onError={() => setFailed(key)} style={{ visibility: ready ? undefined : "hidden" }} />
  </>;
}
