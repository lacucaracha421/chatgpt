import { useEffect, useRef, useState } from "react";
import { motionDefaults, motionTime, reducedMotion } from "../../shared/motion/curves";

type CoverSlot = { src: string; version: number; ready?: boolean };
/** Keep the painted cover until the actual next backdrop image has loaded and decoded. */
export function WorkBackdrop({ src, onReady }: { src: string | null; onReady?(): void }) {
  const [slots, setSlots] = useState<CoverSlot[]>(src ? [{ src, version: 0 }] : []);
  const [painted, setPainted] = useState<number | null>(null);
  const [settled, setSettled] = useState<number | null>(null);
  const pruneTimers = useRef(new Set<number>());
  useEffect(() => () => { pruneTimers.current.forEach(timer => window.clearTimeout(timer)); }, []);
  const request = useRef({ src, version: 0 });
  if (request.current.src !== src) request.current = { src, version: request.current.version + 1 };
  const version = request.current.version;
  useEffect(() => {
    if (!src) {
      if (slots.length) setSlots([]);
      if (painted !== null) setPainted(null);
      return;
    }
    if (slots.some(slot => slot.version === painted && slot.src === src)) {
      if (slots.some(slot => !slot.ready)) setSlots(current => current.filter(slot => slot.ready));
      setSettled(version); return;
    }
    if (!slots.some(slot => slot.src === src && slot.version === version)) {
      // A later request must not replace a layer that is still contributing to the fade.
      setSlots(current => [...current.filter(slot => slot.ready), { src, version }]);
    }
  }, [src, slots, painted, version]);
  useEffect(() => {
    if (painted === null) return;
    const duration = reducedMotion() ? motionTime("--motion-micro", motionDefaults.micro) : motionTime("--motion-medium", motionDefaults.medium);
    const timer = window.setTimeout(() => {
      pruneTimers.current.delete(timer);
      setSlots(current => current.filter(slot => !slot.ready || slot.version >= painted));
    }, duration);
    // Each completed layer can prune what it covers, even while a newer layer is fading.
    pruneTimers.current.add(timer);
  }, [painted]);
  useEffect(() => { if (!src || settled === version) onReady?.(); });
  if (!src) return null;
  return <div className="work-backdrop" aria-hidden="true">
    {slots.map(slot => <img key={slot.version} src={slot.src} alt="" draggable={false}
      className={painted === slot.version ? "is-painted" : slot.ready ? "is-underlay" : undefined}
      onLoad={async event => {
        const image = event.currentTarget;
        try { await image.decode?.(); } catch { if (request.current.version === slot.version) setSettled(slot.version); return; }
        if (image.isConnected && request.current.src === slot.src && request.current.version === slot.version) {
          setSlots(current => current.map(item => item.version === slot.version ? { ...item, ready: true } : item));
          setPainted(slot.version); setSettled(slot.version);
        }
      }} onError={() => { if (request.current.version === slot.version) setSettled(slot.version); }} />)}
  </div>;
}
