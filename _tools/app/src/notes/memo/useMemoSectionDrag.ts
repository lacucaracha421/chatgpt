import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type RefObject } from 'react';

export const MEMO_DRAG_HOLD_MS = 250;
type Box = { id: string; top: number; height: number };
type Session = {
  id: string; pointer: number; x: number; y: number; lastY: number; delta: number;
  from: number; to: number; boxes: Box[]; head: HTMLElement; pane: HTMLElement;
  scrollTop: number; active: boolean; scrolling: boolean; touch: boolean;
};

function scrollPane(from: HTMLElement): HTMLElement {
  for (let node = from.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return document.scrollingElement as HTMLElement ?? document.documentElement;
}

/** The preview only moves painted sections. Persistence happens once, on a successful drop. */
export function useMemoSectionDrag(root: RefObject<HTMLDivElement | null>, enabled: boolean, sessionKey: string, onDrop: (id: string, index: number) => void) {
  const [preview, setPreview] = useState<Session | null>(null);
  const session = useRef<Session | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);
  const drop = useRef(onDrop); drop.current = onDrop;

  function stop(commit = false) {
    clearTimeout(timer.current); cancelAnimationFrame(frame.current ?? 0);
    const current = session.current; session.current = null;
    if (current?.active || current?.scrolling) suppressClick.current = true;
    if (current?.head.hasPointerCapture?.(current.pointer)) current.head.releasePointerCapture(current.pointer);
    // Body edits invalidate a drag session too. Avoid scheduling a state update
    // on every keystroke when there has never been a drag preview to clear.
    if (current?.active || preview !== null) setPreview(null);
    if (commit && current?.active && current.to !== current.from) drop.current(current.id, current.to);
  }
  function update(current: Session) {
    const scroll = current.pane.scrollTop - current.scrollTop;
    current.delta = current.lastY - current.y + scroll;
    const own = current.boxes[current.from]!;
    const centre = own.top + own.height / 2 + current.delta;
    current.to = current.boxes.filter(box => box.id !== current.id && centre > box.top + box.height / 2).length;
    setPreview({ ...current });
  }
  function autoscroll() {
    const current = session.current; if (!current?.active) return;
    const box = current.pane === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : current.pane.getBoundingClientRect();
    const speed = current.lastY < box.top + 56 ? -Math.min(16, (box.top + 56 - current.lastY) / 4)
      : current.lastY > box.bottom - 56 ? Math.min(16, (current.lastY - box.bottom + 56) / 4) : 0;
    if (speed) { current.pane.scrollTop += speed; update(current); }
    frame.current = requestAnimationFrame(autoscroll);
  }
  function start(current: Session) {
    clearTimeout(timer.current);
    current.active = true;
    current.head.setPointerCapture?.(current.pointer);
    suppressClick.current = true;
    update(current); frame.current = requestAnimationFrame(autoscroll);
  }
  useEffect(() => {
    if (!enabled) return;
    function move(event: globalThis.PointerEvent) {
      const current = session.current; if (!current || current.pointer !== event.pointerId) return;
      if (!current.active && !current.scrolling && Math.hypot(event.clientX - current.x, event.clientY - current.y) >= (current.touch ? 8 : 4)) {
        if (current.touch) {
          clearTimeout(timer.current); current.scrolling = true;
          current.head.setPointerCapture?.(current.pointer);
        } else start(current);
      }
      if (current.scrolling) {
        current.pane.scrollTop -= event.clientY - current.lastY; event.preventDefault();
      }
      current.lastY = event.clientY;
      if (current.active) { event.preventDefault(); update(current); }
    }
    function end(event: globalThis.PointerEvent) { if (session.current?.pointer === event.pointerId) stop(event.type === 'pointerup'); }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape' && session.current) { event.preventDefault(); event.stopPropagation(); stop(); }
    }
    const blur = () => stop();
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', blur);
    return () => {
      clearTimeout(timer.current); cancelAnimationFrame(frame.current ?? 0); session.current = null;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur);
    };
  }, [enabled, sessionKey]);
  useEffect(() => { stop(); }, [enabled, sessionKey]);

  function pointerDown(event: PointerEvent<HTMLElement>, id: string) {
    suppressClick.current = false;
    if (!enabled || event.button !== 0 || (event.target as Element).closest('input')) return;
    if (session.current) { stop(); return; }
    const boxes = [...root.current!.querySelectorAll<HTMLElement>('[data-memo-section]')].map(node => {
      const box = node.getBoundingClientRect(); return { id: node.dataset.memoSection!, top: box.top, height: box.height };
    });
    const from = boxes.findIndex(box => box.id === id); if (from < 0) return;
    const pane = scrollPane(event.currentTarget);
    const current: Session = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, delta: 0,
      from, to: from, boxes, head: event.currentTarget, pane, scrollTop: pane.scrollTop, active: false, scrolling: false, touch: event.pointerType === 'touch' };
    session.current = current;
    if (current.touch) timer.current = setTimeout(() => { if (session.current === current) start(current); }, MEMO_DRAG_HOLD_MS);
  }
  function clickCapture(event: MouseEvent) {
    if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); }
  }
  function offset(id: string): number {
    if (!preview) return 0;
    const { boxes, from, to } = preview;
    const own = boxes[from]!;
    const index = boxes.findIndex(box => box.id === id);
    const gap = from + 1 < boxes.length ? boxes[from + 1]!.top - own.top - own.height
      : from > 0 ? own.top - boxes[from - 1]!.top - boxes[from - 1]!.height : 24;
    const shift = own.height + gap;
    return id === preview.id ? preview.delta : index > from && index <= to ? -shift : index < from && index >= to ? shift : 0;
  }
  function style(id: string): CSSProperties | undefined {
    return preview ? { transform: `translateY(${offset(id)}px)` } : undefined;
  }
  let indicator: number | undefined;
  if (preview && root.current) {
    const order = preview.boxes.filter(box => box.id !== preview.id);
    const next = order[preview.to];
    const previous = order[preview.to - 1];
    const target = next ?? previous;
    indicator = (next ? next.top : previous ? previous.top + previous.height : preview.boxes[preview.from]!.top)
      + (target ? offset(target.id) : 0) - root.current.getBoundingClientRect().top - (preview.pane.scrollTop - preview.scrollTop);
  }
  return { pointerDown, clickCapture, resetClick: () => { suppressClick.current = false; }, style, dragged: preview?.id, indicator };
}
