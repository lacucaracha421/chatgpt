import { useEffect, useRef, useState } from "react";

type CoverSlot = { src: string; version: number };
/** Keep the painted cover until the actual next backdrop image has loaded and decoded. */
export function WorkBackdrop({ src }: { src: string | null }) {
  const [slots, setSlots] = useState<[CoverSlot | null, CoverSlot | null]>([src ? { src, version: 0 } : null, null]);
  const [painted, setPainted] = useState<0 | 1 | null>(null);
  const request = useRef({ src, version: 0 });
  if (request.current.src !== src) request.current = { src, version: request.current.version + 1 };
  const version = request.current.version;
  useEffect(() => {
    if (!src) {
      if (slots.some(Boolean)) setSlots([null, null]);
      if (painted !== null) setPainted(null);
      return;
    }
    if (painted !== null && slots[painted]?.src === src) return;
    const next = painted === 0 ? 1 : 0;
    if (slots[next]?.src !== src || slots[next]?.version !== version) {
      const incoming = { src, version };
      setSlots(current => next === 0 ? [incoming, current[1]] : [current[0], incoming]);
    }
  }, [src, slots, painted, version]);
  if (!src) return null;
  return <div className="work-backdrop" aria-hidden="true">
    {slots.map((slot, index) => slot && <img key={`${index}:${slot.src}:${slot.version}`} src={slot.src} alt="" draggable={false}
      className={painted === index ? "is-painted" : undefined}
      onLoad={async event => {
        const image = event.currentTarget;
        try { await image.decode?.(); } catch { return; }
        if (image.isConnected && request.current.src === slot.src && request.current.version === slot.version) setPainted(index as 0 | 1);
      }} />)}
  </div>;
}
