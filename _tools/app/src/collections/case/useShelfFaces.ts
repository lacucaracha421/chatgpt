import { useEffect, useReducer, useRef } from "react";
import { READY_CAP_MS } from "../../shared/motion/AreaSwitch";

type Slot = { src: string | null; ready: boolean; decoding: boolean; ratio: number };
type Face = { slots: [Slot, Slot | null]; current: Slot; shown: Slot | null };
type Faces = Record<"front" | "spine", Face>;
export type ShelfPending = { frontPending?: boolean; spinePending?: boolean };
const names = ["front", "spine"] as const;
// Only size/decode hints, never image bytes or a new persistent cache. A hint is
// used only when the actual mounted image is also a complete browser-cache hit.
const decodedRatios = new Map<string, number>();
const slot = (src: string | null): Slot => ({ src, ready: !src, decoding: false, ratio: (src && decodedRatios.get(src)) || .71 });
function face(src: string | null): Face { const current = slot(src); return { slots: [current, null], current, shown: null }; }

/** Two actual DOM slots per face; publish together, or retain each old face after the cap. */
export function useShelfFaces(front: string | null, spine: string | null, pending: ShelfPending) {
  const [, update] = useReducer(value => value + 1, 0);
  const placeholderRatio = useRef((front && decodedRatios.get(front)) || .71);
  const state = useRef<{ faces: Faces; signature: string; cycle: { expired: boolean; complete: boolean } } | null>(null);
  const signature = JSON.stringify([front, spine, !!pending.frontPending, !!pending.spinePending]);
  state.current ??= { faces: { front: face(front), spine: face(spine) }, signature, cycle: { expired: false, complete: false } };
  const current = state.current;
  if (signature !== current.signature) {
    // A late ticket joins the existing deadline; an actual source replacement
    // gets a new bounded wait, even if the previous request hit its cap.
    const replacesSource = names.some(name => current.faces[name].current.src !== null && current.faces[name].current.src !== (name === "front" ? front : spine));
    if (current.cycle.complete || replacesSource) current.cycle = { expired: false, complete: false };
    current.signature = signature;
    for (const name of names) {
      const target = current.faces[name], src = name === "front" ? front : spine;
      if (target.current.src === src) continue;
      const remembered = target.slots.find(value => value?.src === src && value.ready);
      if (remembered) target.current = remembered;
      else {
        const index = target.shown === target.slots[0] ? 1 : 0;
        target.current = slot(src);
        target.slots[index] = target.current;
      }
    }
  }
  const { faces, cycle } = current;
  const ready = faces.front.current.ready && faces.spine.current.ready && !pending.frontPending && !pending.spinePending;
  if (ready || cycle.expired) {
    for (const name of names) {
      const target = faces[name];
      if (target.current.ready && !(name === "front" ? pending.frontPending : pending.spinePending)) target.shown = target.current;
    }
  }
  cycle.complete = ready;
  useEffect(() => {
    if (ready || cycle.expired) return;
    const timer = setTimeout(() => { cycle.expired = true; update(); }, READY_CAP_MS);
    return () => clearTimeout(timer);
  }, [cycle, ready]);

  function loaded(name: keyof Faces, value: Slot, image: HTMLImageElement) {
    if (value.ready || value.decoding) return;
    const valid = () => image.isConnected && image.getAttribute("src") === value.src && faces[name].slots.includes(value);
    const finish = () => {
      if (!valid() || value.ready) return;
      value.ready = true;
      if (image.naturalWidth && image.naturalHeight) value.ratio = Math.max(.4, Math.min(1.4, image.naturalWidth / image.naturalHeight));
      if (value.src) {
        decodedRatios.delete(value.src);
        decodedRatios.set(value.src, value.ratio);
        if (decodedRatios.size > 2048) decodedRatios.delete(decodedRatios.keys().next().value!);
      }
      update();
    };
    // A warm remount commits before paint, without waiting for a load event,
    // effect, animation frame or timer. Cold elements decode in their real slot.
    if (image.complete && image.naturalWidth > 0 && decodedRatios.has(value.src!)) finish();
    else if (typeof image.decode === "function") {
      value.decoding = true;
      void image.decode().then(() => { value.decoding = false; finish(); }, () => { value.decoding = false; });
    }
    else finish();
  }
  return {
    faces, ready, revealed: cycle.expired || Boolean(faces.front.shown || faces.spine.shown),
    ratio: faces.front.shown?.ratio ?? placeholderRatio.current,
    imageProps(name: keyof Faces, value: Slot) {
      return {
        // Synchronous decoding on browser-cache hits avoids a newly mounted
        // element painting a frame later than the DOM spine.
        decoding: decodedRatios.has(value.src!) ? "sync" as const : "async" as const,
        ref(image: HTMLImageElement | null) {
          if (image?.complete && image.naturalWidth > 0) loaded(name, value, image);
        },
        onLoad: (event: { currentTarget: HTMLImageElement }) => loaded(name, value, event.currentTarget),
        // Failed faces remain neutral (or keep their old element); the cap
        // admits the other face. Never expose a broken-image icon.
        style: faces[name].shown === value ? undefined : { position: "absolute" as const, visibility: "hidden" as const, pointerEvents: "none" as const },
        "aria-hidden": faces[name].shown !== value || undefined,
      };
    },
  };
}
