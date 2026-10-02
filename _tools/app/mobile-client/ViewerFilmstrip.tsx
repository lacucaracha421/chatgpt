import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {useHorizontalWheel} from '../src/shared/ui/useHorizontalWheel';
import type {Asset} from './types';
import {loadThumbnail} from './media';

type ViewerFilmstripProps = {
  items: Asset[];
  index: number;
  privacy?: boolean;
  onIndex(index: number): void;
  onInteract?(): void;
  onInteractionChange?(active: boolean): void;
};

type FilmstripWindow = {start: number; end: number};
const WINDOW_RADIUS = 30;
const WINDOW_GROWTH = 30;
const EDGE_THRESHOLD_PX = 112;
const TAP_SLOP_PX = 8;
const loadedThumbnails = new Map<string, string>();

function rememberThumbnail(key: string, url: string) {
  loadedThumbnails.set(key, url);
  while (loadedThumbnails.size > 240) loadedThumbnails.delete(loadedThumbnails.keys().next().value!);
}

function thumbnailKey(asset: Asset) {
  return `${asset.id}:${asset.thumbnail_revision ?? ''}`;
}

function around(index: number, length: number): FilmstripWindow {
  return {start: Math.max(0, index - WINDOW_RADIUS), end: Math.min(length, index + WINDOW_RADIUS + 1)};
}

function FilmstripThumb({asset, current, index, privacy}: {asset: Asset; current: boolean; index: number; privacy: boolean}) {
  const cacheKey = thumbnailKey(asset);
  const [preview, setPreview] = useState(() => asset.preview ?? loadedThumbnails.get(cacheKey));

  useEffect(() => {
    const ready = asset.preview ?? loadedThumbnails.get(cacheKey);
    setPreview(ready);
    if (ready) rememberThumbnail(cacheKey, ready);
    if (privacy || ready || asset.thumbnail_available === false || typeof loadThumbnail !== 'function') return;
    const controller = new AbortController();
    void loadThumbnail(asset, controller.signal).then(result => {
      if (!controller.signal.aborted && result.preview) {
        rememberThumbnail(cacheKey, result.preview);
        setPreview(result.preview);
      }
    }, () => {});
    return () => controller.abort();
  }, [asset.id, asset.preview, asset.thumbnail_available, cacheKey, privacy]);

  return <button
    type="button"
    className={`viewer-filmstrip__button${current ? ' is-current' : ''}`}
    data-filmstrip-index={index}
    aria-label={`${index + 1}번째 자산 보기`}
    aria-current={current ? 'true' : undefined}
  >
    {privacy ? <span className="viewer-filmstrip__placeholder" aria-hidden="true"/> : preview ? <img src={preview} alt="" loading="lazy" decoding="async" draggable={false}/> : <span className="viewer-filmstrip__placeholder" aria-hidden="true"/>}
  </button>;
}

export function ViewerFilmstrip({items, index, privacy = false, onIndex, onInteract, onInteractionChange}: ViewerFilmstripProps) {
  const hidden = items.length <= 1 || items[index]?.kind === 'video';
  const stripRef = useRef<HTMLElement>(null);
  const bindWheel = useHorizontalWheel();
  const bindStrip = useCallback((node: HTMLElement | null) => {
    stripRef.current = node;
    const cleanup = bindWheel(node);
    return () => { cleanup?.(); stripRef.current = null; };
  }, [bindWheel]);
  const centeredIndex = useRef<number | undefined>(undefined);
  const pointer = useRef({id: -1, x: 0, y: 0, dragged: false, active: false});
  const [windowRange, setWindowRange] = useState(() => around(index, items.length));

  useLayoutEffect(() => {
    const target = around(index, items.length);
    setWindowRange(current => {
      const next = {
        start: Math.min(current.start, target.start),
        end: Math.max(Math.min(current.end, items.length), target.end),
      };
      return next.start === current.start && next.end === current.end ? current : next;
    });
  }, [index, items.length]);

  useLayoutEffect(() => {
    if (centeredIndex.current === index) return;
    const strip = stripRef.current;
    const current = strip?.querySelector<HTMLElement>(`[data-filmstrip-index="${index}"]`);
    if (!strip || !current || typeof strip.scrollTo !== 'function') return;
    const left = Math.max(0, Math.min(
      current.offsetLeft + current.offsetWidth / 2 - strip.clientWidth / 2,
      Math.max(0, strip.scrollWidth - strip.clientWidth),
    ));
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    strip.scrollTo({left, behavior: reduced ? 'auto' : 'smooth'});
    centeredIndex.current = index;
  }, [index, windowRange.start, windowRange.end]);

  useEffect(() => () => {
    if (pointer.current.active) onInteractionChange?.(false);
  }, [onInteractionChange]);

  useEffect(() => {
    if (!hidden || !pointer.current.active) return;
    pointer.current.active = false;
    onInteractionChange?.(false);
  }, [hidden, onInteractionChange]);

  if (hidden) return null;
  const start = Math.max(0, Math.min(windowRange.start, items.length));
  const end = Math.max(start, Math.min(windowRange.end, items.length));
  const visible = items.slice(start, end);

  const finishPointer = (pointerId: number, canceled = false) => {
    if (pointer.current.id !== pointerId) return;
    pointer.current.active = false;
    if (canceled) pointer.current.dragged = true;
    onInteractionChange?.(false);
    onInteract?.();
  };

  return <nav
    ref={bindStrip}
    className="viewer-filmstrip"
    aria-label="주변 자산"
    onFocusCapture={() => onInteract?.()}
    onPointerDownCapture={event => {
      event.stopPropagation();
      pointer.current = {id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false, active: true};
      onInteractionChange?.(true);
      onInteract?.();
    }}
    onPointerMoveCapture={event => {
      event.stopPropagation();
      const interaction = pointer.current;
      if (interaction.id === event.pointerId && Math.hypot(event.clientX - interaction.x, event.clientY - interaction.y) > TAP_SLOP_PX) interaction.dragged = true;
    }}
    onPointerUpCapture={event => { event.stopPropagation(); finishPointer(event.pointerId); }}
    onPointerCancelCapture={event => { event.stopPropagation(); finishPointer(event.pointerId, true); }}
    onClickCapture={event => {
      event.stopPropagation();
      const button = (event.target as Element).closest<HTMLElement>('[data-filmstrip-index]');
      if (!button) return;
      if (pointer.current.dragged) { event.preventDefault(); pointer.current.dragged = false; return; }
      const next = Number(button.dataset.filmstripIndex);
      if (Number.isInteger(next)) onIndex(next);
    }}
    onScroll={event => {
      event.stopPropagation();
      onInteract?.();
      const strip = event.currentTarget;
      setWindowRange(current => {
        let {start: nextStart, end: nextEnd} = current;
        if (strip.scrollLeft <= EDGE_THRESHOLD_PX && nextStart > 0) nextStart = Math.max(0, nextStart - WINDOW_GROWTH);
        if (strip.scrollWidth - strip.clientWidth - strip.scrollLeft <= EDGE_THRESHOLD_PX && nextEnd < items.length) nextEnd = Math.min(items.length, nextEnd + WINDOW_GROWTH);
        return nextStart === current.start && nextEnd === current.end ? current : {start: nextStart, end: nextEnd};
      });
    }}
  >
    {visible.map((asset, offset) => {
      const itemIndex = start + offset;
      return <FilmstripThumb key={asset.id} asset={asset} current={itemIndex === index} index={itemIndex} privacy={privacy}/>;
    })}
  </nav>;
}
