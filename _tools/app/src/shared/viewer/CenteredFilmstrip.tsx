import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {useHorizontalWheel} from '../ui/useHorizontalWheel';
import './CenteredFilmstrip.css';

export type StripItem = {id: string; width?: number | null; height?: number | null};
type Props = {
  items: StripItem[]; index: number; height?: number; grown?: boolean; className?: string;
  renderThumbnail(item: StripItem, index: number): ReactNode;
  onIndex(index: number): void; onSwipeUp?(): void; onInteract?(): void; onInteractionChange?(active: boolean): void;
};
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The media viewer is its own control surface: a fixed selection slot with a moving, virtual rail. */
export function CenteredFilmstrip({items, index, height = 124, grown = false, className = '', renderThumbnail, onIndex, onSwipeUp, onInteract, onInteractionChange}: Props) {
  const layout = useMemo(() => {
    let x = 0;
    return items.map(item => {
      const ratio = item.width && item.height ? item.width / item.height : 1;
      const w = height * ratio;
      const box = {x, w, c: x + w / 2}; x += w + 6; return box;
    });
  }, [items, height]);
  const rail = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const node = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(800);
  const [windowRange, setWindowRange] = useState({start: Math.max(0, index - 8), end: Math.min(items.length, index + 9)});
  const latest = useRef({onIndex, onInteract, onInteractionChange, index, grown, layout, width, height});
  latest.current = {onIndex, onInteract, onInteractionChange, index, grown, layout, width, height};
  const state = useRef({off: -(layout[index]?.c ?? 0), target: -(layout[index]?.c ?? 0), velocity: 0, raf: 0, last: 0, free: false, selected: index, dragged: false});
  const drag = useRef<{id: number; x: number; y: number; off: number; samples: [number, number][]} | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nearest = useCallback((off: number) => {
    const boxes = latest.current.layout;
    let lo = 0, hi = boxes.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (boxes[m].c < -off) lo = m + 1; else hi = m; }
    return lo > 0 && Math.abs(boxes[lo - 1].c + off) < Math.abs((boxes[lo]?.c ?? 0) + off) ? lo - 1 : lo;
  }, []);
  const apply = useCallback(() => {
    const s = state.current, current = latest.current;
    if (rail.current) rail.current.style.transform = `translate3d(${s.off}px,0,0)`;
    const n = nearest(s.off), box = current.layout[n];
    if (slot.current && box) slot.current.style.setProperty('--slot-width', `${box.w}px`);
    if (s.free && n !== s.selected) { s.selected = n; current.onIndex(n); }
    const half = current.width / (current.grown ? 2 : 1) + current.height;
    const start = Math.max(0, nearest(s.off + half) - 1), end = Math.min(current.layout.length, nearest(s.off - half) + 2);
    setWindowRange(range => range.start === start && range.end === end ? range : {start, end});
  }, [nearest]);
  const tick = useCallback(function frame(now: number) {
    const s = state.current;
    const dt = Math.min(.032, Math.max(0, (now - s.last) / 1000)); s.last = now;
    const steps = Math.max(1, Math.ceil(dt / .004)), h = dt / steps;
    for (let j = 0; j < steps; j++) {
      s.velocity += (230 * (s.target - s.off) - 2 * Math.sqrt(230) * s.velocity) * h;
      s.off += s.velocity * h;
    }
    if (Math.abs(s.target - s.off) < .3 && Math.abs(s.velocity) < 6) {
      s.off = s.target; s.velocity = 0; s.raf = 0; apply(); s.free = false; return;
    }
    apply(); s.raf = requestAnimationFrame(frame);
  }, [apply]);
  const kick = useCallback(() => {
    const s = state.current;
    if (reduced()) { cancelAnimationFrame(s.raf); s.raf = 0; s.off = s.target; s.velocity = 0; apply(); s.free = false; return; }
    if (!s.raf) { s.last = performance.now(); s.raf = requestAnimationFrame(tick); }
  }, [apply, tick]);
  const bindWheel = useHorizontalWheel({
    getLeft: () => -state.current.target - (latest.current.layout[0]?.c ?? 0),
    pan: delta => {
      const s = state.current, boxes = latest.current.layout;
      latest.current.onInteract?.(); s.free = true;
      s.target = clamp(s.target - delta, -(boxes[boxes.length - 1]?.c ?? 0), -(boxes[0]?.c ?? 0)); kick();
      clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => { s.target = -(boxes[nearest(s.target)]?.c ?? 0); s.free = true; kick(); }, 140);
    },
  });
  const bind = useCallback((element: HTMLElement | null) => {
    node.current = element;
    const cleanup = bindWheel(element);
    if (!element) return;
    const measure = () => setWidth(element.clientWidth || 800);
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => { cleanup?.(); observer?.disconnect(); node.current = null; };
  }, [bindWheel]);
  useLayoutEffect(() => {
    const s = state.current;
    if (!s.free && !drag.current) { s.selected = index; s.target = -(layout[index]?.c ?? 0); kick(); }
    apply();
  }, [index, layout, grown, width, apply, kick]);
  useEffect(() => {
    const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const change = () => { if (query?.matches) kick(); };
    query?.addEventListener?.('change', change);
    return () => { query?.removeEventListener?.('change', change); cancelAnimationFrame(state.current.raf); clearTimeout(wheelTimer.current); if (drag.current) latest.current.onInteractionChange?.(false); };
  }, [kick]);
  if (items.length < 2) return null;
  const finish = (id: number, canceled = false) => {
    const d = drag.current; if (!d || d.id !== id) return;
    drag.current = null; latest.current.onInteractionChange?.(false); latest.current.onInteract?.();
    const s = state.current;
    if (!s.dragged || canceled) { s.free = false; s.target = -(layout[latest.current.index]?.c ?? 0); kick(); return; }
    const a = d.samples[0], b = d.samples[d.samples.length - 1]!;
    s.velocity = b[0] > a[0] ? clamp((b[1] - a[1]) / (b[0] - a[0]) * 1000, -7000, 7000) : 0;
    s.target = -(layout[nearest(s.off + s.velocity * .22)]?.c ?? 0); s.free = true; kick();
  };
  return <nav ref={bind} className={`centered-filmstrip ${grown ? 'is-grown' : ''} ${className}`} aria-label="주변 자산" style={{"--filmstrip-height": `${height}px`} as React.CSSProperties}
    onFocusCapture={() => onInteract?.()}
    onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); event.stopPropagation(); onIndex(clamp(index + (event.key === 'ArrowLeft' ? -1 : 1), 0, items.length - 1)); onInteract?.(); }}
    onPointerDown={event => {
      if (event.button > 0) return; event.stopPropagation();
      clearTimeout(wheelTimer.current); cancelAnimationFrame(state.current.raf); state.current.raf = 0; state.current.velocity = 0; state.current.dragged = false;
      drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, off: state.current.off, samples: [[performance.now(), state.current.off]]};
      onInteractionChange?.(true); onInteract?.();
    }}
    onPointerMove={event => {
      const d = drag.current; if (!d || d.id !== event.pointerId) return; event.stopPropagation();
      if (d.y - event.clientY > 40 && Math.abs(event.clientX - d.x) < d.y - event.clientY) { onSwipeUp?.(); return; }
      const dx = (event.clientX - d.x) / (grown ? 1 : .5);
      if (Math.abs(dx) < 6 && !state.current.dragged) return;
      event.currentTarget.setPointerCapture?.(event.pointerId); state.current.dragged = true; state.current.free = true;
      state.current.off = state.current.target = clamp(d.off + dx, -(layout[layout.length - 1]?.c ?? 0), -(layout[0]?.c ?? 0));
      const now = performance.now(); d.samples.push([now, state.current.off]);
      while (d.samples.length > 2 && now - d.samples[0][0] > 100) d.samples.shift(); apply();
    }}
    onPointerUp={event => { event.stopPropagation(); finish(event.pointerId); }}
    onPointerCancel={event => { event.stopPropagation(); state.current.dragged = true; finish(event.pointerId, true); }}
    onClickCapture={event => {
      event.stopPropagation();
      if (state.current.dragged) { state.current.dragged = false; event.preventDefault(); return; }
      const button = (event.target as Element).closest<HTMLElement>('[data-filmstrip-index]');
      if (button) { state.current.free = false; onIndex(Number(button.dataset.filmstripIndex)); onInteract?.(); }
    }}>
    <div className="centered-filmstrip__extent" style={{width: width + (layout[layout.length - 1]?.c ?? 0) - (layout[0]?.c ?? 0)}} aria-hidden="true"/>
    <div className="centered-filmstrip__scale">
      <div ref={rail} className="centered-filmstrip__rail">
        {items.slice(windowRange.start, windowRange.end).map((item, offset) => {
          const i = windowRange.start + offset, box = layout[i];
          return <button key={item.id} type="button" data-filmstrip-index={i} className={`centered-filmstrip__item ${i === index ? 'is-current' : ''}`} style={{left: box.x, width: box.w}} aria-label={`${i + 1}번째 자산 보기`} aria-current={i === index ? 'true' : undefined}>{renderThumbnail(item, i)}</button>;
        })}
      </div>
      <div ref={slot} className="centered-filmstrip__slot" aria-hidden="true" style={{'--slot-width': `${layout[index]?.w ?? height}px`} as React.CSSProperties}><i/><i/></div>
    </div>
  </nav>;
}
