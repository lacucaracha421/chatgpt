import { useEffect, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";

type StableImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  src: string;
  alt: string;
  onPreloadError?: () => void;
};

type Slot = { src: string; alt: string; ready?: boolean };

/**
 * Keeps the current image on screen until the next one has loaded and decoded.
 *
 * Two <img> elements take turns: the hidden one loads the next source and becomes the visible one
 * once ready. Showing the element that did the loading matters on the PC (WebKitGTK), which does not
 * reliably reuse a preloaded `lakomics://` image for a fresh <img>, so swapping `src` flashed blank.
 */
export function StableImage({ src, alt, onPreloadError, ...props }: StableImageProps) {
  const [slots, setSlots] = useState<[Slot | null, Slot | null]>([{ src, alt }, null]);
  const [active, setActive] = useState<0 | 1>(0);

  useEffect(() => {
    const current = slots[active];
    if (current?.src === src) {
      if (current.alt !== alt) setSlots((previous) => replaceSlot(previous, active, { ...current, alt }));
      return;
    }
    const other = active === 0 ? 1 : 0;
    const next = slots[other];
    if (next?.src === src) {
      if (next.alt !== alt) setSlots((previous) => replaceSlot(previous, other, { ...next, alt }));
      if (next.ready) setActive(other);
      return;
    }
    setSlots((previous) => replaceSlot(previous, other, { src, alt }));
  }, [active, alt, slots, src]);

  const loaded = (index: 0 | 1, event: SyntheticEvent<HTMLImageElement>) => {
    const loadedSrc = slots[index]?.src;
    const element = event.currentTarget;
    const show = () => {
      if (!element.isConnected || element.getAttribute("src") !== loadedSrc) return;
      // Readiness belongs to the slot; only the effect may promote the currently requested source.
      setSlots(previous => {
        const slot = previous[index];
        return slot?.src === loadedSrc && !slot.ready
          ? replaceSlot(previous, index, { ...slot, ready: true }) : previous;
      });
    };
    if (typeof element.decode === "function") void element.decode().then(show, show);
    else show();
  };
  const failed = (index: 0 | 1) => {
    if (index !== active && slots[index]?.src === src) onPreloadError?.();
  };

  return <>{slots.map((slot, index) => slot && <img
    key={index}
    {...props}
    src={slot.src}
    alt={index === active ? slot.alt : ""}
    // Inline style, not `hidden`: callers' classes (e.g. display: block) would override the attribute.
    // The loading element stays out of layout and invisible but keeps loading and decoding.
    style={index === active ? props.style : { ...props.style, position: "absolute", visibility: "hidden", pointerEvents: "none" }}
    data-stable-image-loading={index !== active ? "true" : undefined}
    aria-hidden={index !== active ? true : undefined}
    onLoad={(event) => { loaded(index as 0 | 1, event); props.onLoad?.(event); }}
    onError={(event) => { failed(index as 0 | 1); if (index === active) props.onError?.(event); }}
  />)}</>;
}

function replaceSlot(slots: [Slot | null, Slot | null], index: 0 | 1, slot: Slot): [Slot | null, Slot | null] {
  return index === 0 ? [slot, slots[1]] : [slots[0], slot];
}
