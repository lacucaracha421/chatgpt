import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes, type Ref, type SyntheticEvent } from "react";

import { beginNativePhase } from "../nativePerf";
import { contentCross, EASE_STANDARD } from "../motion/curves";
import { REVEAL_HOLD_ATTRIBUTE, viewportImageDecoded } from "../motion/viewportImages";

type StableImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  src: string;
  alt: string;
  /** Receives each real image slot (including the spare loading slot). */
  ref?: Ref<HTMLImageElement>;
  onPreloadError?: () => void;
  /** Load one adjacent image in the actual spare DOM slot, after the current image is ready. */
  prefetchSrc?: string;
  /** Opt-in native-kit tracing; absent in ordinary image surfaces. */
  perfName?: string;
  /**
   * A new shelf cover may paint on load (no late 150ms fade either); replacements still
   * decode in the spare slot.
   */
  decodeFirst?: boolean;
};

type Slot = { src: string; alt: string; ready?: boolean; decoded?: boolean; failed?: boolean };

/**
 * Keeps the current image on screen until the next one has loaded and decoded.
 *
 * Two <img> elements take turns: the hidden one loads the next source and becomes the visible one
 * once ready. Showing the element that did the loading matters on the PC (WebKitGTK), which does not
 * reliably reuse a preloaded `lakomics://` image for a fresh <img>, so swapping `src` flashed blank.
 */
export function StableImage({ src, alt, onPreloadError, prefetchSrc, perfName, decodeFirst = true, ...props }: StableImageProps) {
  const [slots, setSlots] = useState<[Slot | null, Slot | null]>([{ src, alt }, null]);
  const [active, setActive] = useState<0 | 1>(0);
  const appeared = useRef(false);
  const cached = useRef(new WeakMap<HTMLImageElement, string>());
  const imageRef = useCallback((element: HTMLImageElement | null) => {
    // Capture cache readiness at attachment, before a later load event can hide painted pixels.
    if (element?.complete && element.naturalWidth) cached.current.set(element, element.getAttribute("src") ?? "");
    if (typeof props.ref === "function") return props.ref(element);
    if (props.ref) props.ref.current = element;
  }, [props.ref]);
  const fade = useRef<Animation | null>(null);
  useEffect(() => () => fade.current?.cancel(), []);

  const wanted = useRef(src);
  wanted.current = src;
  const trace = useRef<ReturnType<typeof beginNativePhase>>(null);
  useLayoutEffect(() => {
    if (!perfName) return;
    const phase = beginNativePhase(`${perfName}.request`);
    trace.current = phase;
    // Paint of the slot's mount: with the viewer's zoom preview, the first picture on screen.
    const stopPaint = phase?.afterPaint("mounted-paint");
    return () => { stopPaint?.(); phase?.cancel(); trace.current = null; };
  }, [src, perfName]);
  useLayoutEffect(() => {
    if (slots[active]?.src !== src || !slots[active]?.ready) return;
    trace.current?.mark(slots[active]?.decoded ? "decoded" : "load-ready");
    return trace.current?.afterPaint("visible");
  }, [active, src, slots]);

  useEffect(() => {
    const current = slots[active];
    if (current?.src === src) {
      if (current.alt !== alt) setSlots((previous) => replaceSlot(previous, active, { ...current, alt }));
      const other = active === 0 ? 1 : 0;
      if (current.ready && prefetchSrc && prefetchSrc !== src && slots[other]?.src !== prefetchSrc) {
        setSlots(previous => replaceSlot(previous, other, { src: prefetchSrc, alt: "" }));
      }
      return;
    }
    const other = active === 0 ? 1 : 0;
    const next = slots[other];
    if (next?.src === src) {
      if (next.alt !== alt) setSlots((previous) => replaceSlot(previous, other, { ...next, alt }));
      if (next.failed) onPreloadError?.();
      else if (next.ready) setActive(other);
      return;
    }
    setSlots((previous) => replaceSlot(previous, other, { src, alt }));
  }, [active, alt, slots, src, prefetchSrc, onPreloadError]);

  const loaded = (index: 0 | 1, event: SyntheticEvent<HTMLImageElement>) => {
    const loadedSrc = slots[index]?.src;
    const element = event.currentTarget;
    // A first bitmap must not paint while its asynchronous decode is still pending.
    // decodeFirst={false} callers paint their first bitmap on load and own its arrival.
    const held = decodeFirst && !appeared.current && loadedSrc === wanted.current && !slots[index]?.decoded && cached.current.get(element) !== loadedSrc && !viewportImageDecoded(element);
    if (held) element.style.opacity = "0";
    const show = (decoded: boolean) => {
      // Always release the hold, even when the source moved on meanwhile: React does not own
      // this inline opacity, so a stale hold would keep a later bitmap invisible for good.
      if (held) element.style.opacity = props.style?.opacity === undefined ? "" : String(props.style.opacity);
      if (!element.isConnected || element.getAttribute("src") !== loadedSrc) return;
      if (loadedSrc === wanted.current && !appeared.current) {
        appeared.current = true;
        // The area owns prepared images; only late first loads get their own fade. A late tile held
        // for a shared reveal (revealTogether) appears with its batch, not on a fade of its own.
        const preparing = element.closest('[data-folder-move="pending"], [data-motion-view][style*="opacity: 0"]') || element.hasAttribute(REVEAL_HOLD_ATTRIBUTE);
        if (held && !preparing && typeof element.animate === "function") {
          fade.current = element.animate([{opacity: 0}, {opacity: props.style?.opacity ?? 1}], {duration: contentCross.image, easing: EASE_STANDARD});
        }
      } else if (loadedSrc === wanted.current && index !== active) {
        fade.current?.cancel(); fade.current = null;
      }
      // A late speculative decode may only promote the source still requested by the viewer.
      if (loadedSrc === wanted.current) setActive(index);
      setSlots(previous => {
        const slot = previous[index];
        return slot?.src === loadedSrc && !slot.ready
          ? replaceSlot(previous, index, { ...slot, ready: true, decoded }) : previous;
      });
    };
    if (loadedSrc === wanted.current) trace.current?.mark("loaded");
    if (!decodeFirst && index === active && !slots[index]?.ready && slots[1 - index] === null) {
      show(false);
      return;
    }
    const phase = perfName ? beginNativePhase(`${perfName}.${loadedSrc === wanted.current ? "decode" : "prefetch-decode"}`) : null;
    const decoded = () => { phase?.mark("done"); phase?.cancel(); show(true); };
    if (typeof element.decode === "function") void element.decode().then(decoded, decoded);
    else decoded();
  };
  const failed = (index: 0 | 1) => {
    // A speculative failure must not replace the current image with an error surface.
    if (index !== active) setSlots(previous => previous[index]
      ? replaceSlot(previous, index, { ...previous[index]!, failed: true }) : previous);
  };

  return <>{slots.map((slot, index) => slot && <img
    key={index}
    {...props}
    ref={imageRef}
    loading={index !== active ? "eager" : props.loading}
    src={slot.src}
    alt={index === active ? slot.alt : ""}
    // Inline style, not `hidden`: callers' classes (e.g. display: block) would override the attribute.
    // The loading element stays out of layout and invisible but keeps loading and decoding.
    style={index === active ? props.style : { ...props.style, position: "absolute", visibility: "hidden", pointerEvents: "none" }}
    data-stable-image-loading={index !== active ? "true" : undefined}
    data-stable-image-pending={index !== active && slot.src === src ? "true" : undefined}
    aria-hidden={index !== active ? true : undefined}
    onLoad={(event) => { loaded(index as 0 | 1, event); if (slot.src === src) props.onLoad?.(event); }}
    onError={(event) => { failed(index as 0 | 1); if (index === active) props.onError?.(event); }}
  />)}</>;
}

function replaceSlot(slots: [Slot | null, Slot | null], index: 0 | 1, slot: Slot): [Slot | null, Slot | null] {
  return index === 0 ? [slot, slots[1]] : [slots[0], slot];
}
