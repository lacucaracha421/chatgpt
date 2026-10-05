import { createContext, useContext, useLayoutEffect,useCallback, useRef} from 'react';

export type TileRect = {left: number; top: number; width: number; height: number};
export function viewerTile(id: string | null) {
  return id ? Array.from(document.querySelectorAll<HTMLElement>('[data-asset-id]')).find(tile => tile.dataset.assetId === id && !tile.closest('.asset-viewer, .viewer')) : undefined;
}
export function visibleTileRect(id: string | null): TileRect | undefined {
  const tile = viewerTile(id), r = tile?.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return;
  const clip = tile?.closest('.asset-gallery__scroll, .gallery-scroll')?.getBoundingClientRect();
  if (clip && clip.width > 0 && clip.height > 0 && (r.bottom <= clip.top || r.top >= clip.bottom || r.right <= clip.left || r.left >= clip.right)) return;
  return {left: r.left, top: r.top, width: r.width, height: r.height};
}
/** Replaces the viewer's own close: an image opened from Home closes by switching back to Home. */
export const ViewerExit = createContext<(() => void) | null>(null);
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const sheet = 'cubic-bezier(.32,.72,0,1)';
const standard = 'cubic-bezier(.2,0,0,1)';

/** Own only the viewer's entrance/exit; decoded content changes remain instant. */
export function useViewerMotion(id: string | null, onClose: () => void, origin?: TileRect, aspect = 1, source?: string, sourceId = id, masked = false) {
  const root = useRef<HTMLElement | null>(null);
  const first = useRef<{id: string | null; rect?: TileRect; tile?: HTMLElement}>({id: null});
  const current = useRef({id, onClose, origin, aspect, masked}); current.current = {id, onClose, origin, aspect, masked};
  const sources = useRef(new Map<string, string>());
  if (source && sourceId) sources.current.set(source, sourceId);
  const closing = useRef(false);
  const exitHandler = useContext(ViewerExit);
  const exit = useRef(exitHandler); exit.current = exitHandler;
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const bind = useCallback((node: HTMLElement | null) => {
    cleanup.current?.(); cleanup.current = undefined; root.current = node;
    if (!node) return;
    closing.current = false;
    first.current = {id: current.current.id, rect: current.current.origin ?? visibleTileRect(current.current.id), tile: viewerTile(current.current.id)};
    const backdrop = node.querySelector<HTMLElement>('[data-viewer-backdrop]');
    const media = node.querySelector<HTMLElement>('[data-viewer-media]');
    delete node.dataset.viewerClosing;
    if (current.current.masked || reduced() || !media || typeof media.animate !== 'function') return;
    const animations: Animation[] = [];
    const from = first.current.rect;
    const bounds = media.getBoundingClientRect();
    const fitW = Math.min(bounds.width, bounds.height * current.current.aspect), fitH = fitW / current.current.aspect;
    const fit = {left: bounds.left + (bounds.width - fitW) / 2, top: bounds.top + (bounds.height - fitH) / 2, width: fitW, height: fitH};
    let ghost: HTMLImageElement | undefined;
    const thumb = first.current.tile?.querySelector('img');
    if (from && thumb && fit.width > 0) {
      ghost = thumb.cloneNode() as HTMLImageElement;
      ghost.removeAttribute('class'); ghost.removeAttribute('id'); ghost.alt = ''; ghost.setAttribute('aria-hidden', 'true'); ghost.dataset.viewerZoomPreview = 'true';
      Object.assign(ghost.style, {position: 'fixed', left: `${fit.left}px`, top: `${fit.top}px`, width: `${fit.width}px`, height: `${fit.height}px`, objectFit: 'contain', zIndex: '1', pointerEvents: 'none'});
      // Above the media, below the strip and bars (z 2+): a grown strip must not drop behind the zoom copy.
      node.append(ghost);
      const mediaOpacity = media.style.opacity; media.style.opacity = '0';
      const dx = from.left + from.width / 2 - fit.left - fit.width / 2, dy = from.top + from.height / 2 - fit.top - fit.height / 2;
      const a = ghost.animate([{transform: `translate(${dx}px,${dy}px) scale(${from.width / fit.width})`}, {transform: 'none'}], {duration: 380, easing: sheet, fill: 'both'});
      animations.push(a);
      let finished = false, ready = false;
      const remove = () => { if (finished && ready) { ghost?.remove(); ghost = undefined; } };
      a.onfinish = () => { finished = true; media.style.opacity = mediaOpacity; remove(); };
      const loaded = (event: Event) => {
        const image = event.target;
        if (!media.contains(image as Node)) return;
        if (image instanceof HTMLMediaElement) { ready = true; remove(); return; }
        if (!(image instanceof HTMLImageElement)) return;
        void (image.decode?.() ?? Promise.resolve()).catch(() => {}).then(() => { ready = true; remove(); });
      };
      node.addEventListener('load', loaded, true);
      node.addEventListener('error', loaded, true);
      node.addEventListener('loadeddata', loaded, true);
      if (Array.from(media.querySelectorAll('img')).some(image => image.complete && image.naturalWidth > 0)) ready = true;
      cleanup.current = () => { node.removeEventListener('load', loaded, true); node.removeEventListener('error', loaded, true); node.removeEventListener('loadeddata', loaded, true); ghost?.remove(); media.style.opacity = mediaOpacity; animations.forEach(animation => animation.cancel()); };
    } else {
      animations.push(media.animate([{opacity: 0, transform: 'scale(.96)'}, {opacity: 1, transform: 'none'}], {duration: 180, easing: sheet}));
      cleanup.current = () => animations.forEach(animation => animation.cancel());
    }
    const overlay = node.closest('.ui-dialog')?.previousElementSibling;
    if (overlay instanceof HTMLElement && overlay.classList.contains('ui-dialog__overlay') && overlay.animate) animations.push(overlay.animate([{opacity: 0}, {opacity: 1}], {duration: 228, easing: standard}));
    if (backdrop?.animate) animations.push(backdrop.animate([{opacity: 0}, {opacity: 1}], {duration: 228, easing: standard}));
    const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const finishEntrance = cleanup.current;
    const preferenceChanged = () => { if (query?.matches) animations.forEach(animation => animation.finish()); };
    query?.addEventListener?.('change', preferenceChanged);
    cleanup.current = () => { query?.removeEventListener?.('change', preferenceChanged); finishEntrance?.(); };
  }, []);
  useLayoutEffect(() => {
    if(!masked)return;
    cleanup.current?.();cleanup.current=undefined;
    root.current?.querySelectorAll('[data-viewer-zoom-preview]').forEach(node=>node.remove());
    sources.current.clear();
  },[masked]);
  const close = useCallback(() => {
    if (closing.current) return;
    if (exit.current) { exit.current(); return; }
    const node = root.current, media = node?.querySelector<HTMLElement>('[data-viewer-media]');
    if (!node || !media || reduced() || typeof media.animate !== 'function') { current.current.onClose(); return; }
    closing.current = true;
    const preview = node.querySelector<HTMLImageElement>('[data-viewer-zoom-preview]');
    const previewTransform = preview ? getComputedStyle(preview).transform : 'none';
    const keepPreview = preview ?? undefined;
    cleanup.current?.(); cleanup.current = undefined;
    if (keepPreview) { node.append(keepPreview); media.style.opacity = '0'; }
    const shown = media.querySelector<HTMLImageElement>('img:not([data-stable-image-loading]):not(.viewer-placeholder)');
    // StableImage preserves the painted slot while a different asset is pending.
    const shownId = keepPreview ? first.current.id : (shown && sources.current.get(shown.getAttribute("src") ?? "")) ?? current.current.id;
    const to = visibleTileRect(shownId), r = media.getBoundingClientRect();
    const ratio = shown?.naturalWidth && shown.naturalHeight ? shown.naturalWidth / shown.naturalHeight : current.current.aspect;
    const w = Math.min(r.width, r.height * ratio), h = w / ratio;
    const dx = to ? to.left + to.width / 2 - r.left - r.width / 2 : 0;
    const dy = to ? to.top + to.height / 2 - r.top - r.height / 2 : 0;
    const destination = to && w > 0 && h > 0 ? `translate(${dx}px,${dy}px) scale(${to.width / w})` : 'scale(.96)';
    const duration = to ? 320 : 180;
    const animation = (keepPreview ?? media).animate([{transform: keepPreview ? previewTransform || 'none' : 'none', opacity: 1}, {transform: destination, opacity: to ? 1 : 0}], {duration, easing: sheet, fill: 'forwards'});
    const backdrop = node.querySelector<HTMLElement>('[data-viewer-backdrop]');
    const overlay = node.closest('.ui-dialog')?.previousElementSibling;
    const overlayFade = overlay instanceof HTMLElement && overlay.classList.contains('ui-dialog__overlay') ? overlay.animate?.([{opacity: 1}, {opacity: 0}], {duration: to ? 266 : 180, easing: standard, fill: 'forwards'}) : undefined;
    const fade = backdrop?.animate?.([{opacity: 1}, {opacity: 0}], {duration: to ? 266 : 180, easing: standard, fill: 'forwards'});
    node.dataset.viewerClosing = 'true';
    const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const done = () => { query?.removeEventListener?.('change', preferenceChanged); current.current.onClose(); };
    const preferenceChanged = () => { if (query?.matches) { animation.cancel(); done(); } };
    query?.addEventListener?.('change', preferenceChanged);
    animation.onfinish = done;
    cleanup.current = () => { query?.removeEventListener?.('change', preferenceChanged); animation.cancel(); fade?.cancel(); overlayFade?.cancel(); keepPreview?.remove(); media.style.opacity = ''; };
  }, []);
  const back = useCallback(() => {
    if (reduced() || typeof root.current?.querySelector<HTMLElement>("[data-viewer-media]")?.animate !== "function") return false;
    close(); return true;
  }, [close]);
  return {bind, close, back};
}
