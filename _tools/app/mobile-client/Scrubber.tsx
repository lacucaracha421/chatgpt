import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject} from 'react';
import {buildScrubberModel, scrubberIndexAt, scrubberRatioAt, type ScrubberSort} from './scrubberModel';
import './scrubber.css';

const DRAG_THRESHOLD = 8;
const HINT_MS = 1000;
const RELEASE_MS = 800;
const FADE_MS = 180;

type Metrics = {long: boolean; progress: number; top: number; bottom: number};

export function Scrubber({scrollRef, total, sort, hidden = false, onEndReached}: {scrollRef: RefObject<HTMLElement | null>; total: number; sort: ScrubberSort; hidden?: boolean; onEndReached?(): void}) {
  const sortValues = sort.kind === 'fallback' ? undefined : sort.values;
  const model = useMemo(() => buildScrubberModel(sort, total), [sort.kind, sortValues, total]);
  const [metrics, setMetrics] = useState<Metrics>({long: false, progress: 0, top: 0, bottom: 0});
  const [hint, setHint] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'active' | 'released'>('idle');
  const [fading, setFading] = useState(false);
  const [position, setPosition] = useState({ratio: 0, index: 0});
  const positionRef = useRef(position);
  positionRef.current = position;
  const start = useRef<{x: number; y: number; pointerId: number} | null>(null);
  const scrubbing = useRef(false);
  const lastMajor = useRef<number | null>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  const releaseTimer = useRef<number | undefined>(undefined);
  const fadeTimer = useRef<number | undefined>(undefined);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const onEndReachedRef = useRef(onEndReached);
  onEndReachedRef.current = onEndReached;

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const client = element.clientHeight;
    const scrollHeight = element.scrollHeight;
    const range = Math.max(0, scrollHeight - client);
    const rect = element.getBoundingClientRect();
    const fallbackLong = client <= 0 && total >= 24;
    setMetrics({
      long: hidden ? false : client > 0 ? scrollHeight > client * 1.5 : fallbackLong,
      progress: range > 0 ? Math.max(0, Math.min(1, element.scrollTop / range)) : scrubberRatioAt(positionRef.current.index, total),
      top: rect.top,
      bottom: Math.max(0, window.innerHeight - (rect.bottom || window.innerHeight)),
    });
  }, [hidden, scrollRef, total]);

  useLayoutEffect(() => {
    measure();
    const element = scrollRef.current;
    if (!element) return;
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('resize', measure); };
  }, [measure, scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      measure();
      if (scrubbing.current || hidden) return;
      setHint(true);
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setHint(false), HINT_MS);
    };
    element.addEventListener('scroll', onScroll, {passive: true});
    return () => { element.removeEventListener('scroll', onScroll); window.clearTimeout(hintTimer.current); };
  }, [hidden, measure, scrollRef]);

  useEffect(() => {
    return () => { window.clearTimeout(releaseTimer.current); window.clearTimeout(fadeTimer.current); };
  }, []);

  useEffect(() => {
    if (hidden || !metrics.long || total <= 1) {
      setPhase('idle'); setFading(false); setHint(false); start.current = null; scrubbing.current = false;
      window.clearTimeout(releaseTimer.current); window.clearTimeout(fadeTimer.current);
    }
  }, [hidden, metrics.long, total]);

  const cancelRelease = () => { window.clearTimeout(releaseTimer.current); window.clearTimeout(fadeTimer.current); setFading(false); };

  const finishRelease = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    setPhase('released');
    window.clearTimeout(releaseTimer.current); window.clearTimeout(fadeTimer.current);
    releaseTimer.current = window.setTimeout(() => {
      setFading(true);
      fadeTimer.current = window.setTimeout(() => { setPhase('idle'); setFading(false); }, FADE_MS);
    }, RELEASE_MS);
  };

  const updateFromX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 30;
    const width = rect?.width || Math.max(1, window.innerWidth - 60);
    const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
    const index = scrubberIndexAt(ratio, total);
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = ratio * Math.max(0, element.scrollHeight - element.clientHeight);
      measure();
    }
    setPosition({ratio, index});
    const major = model.ticks.filter(tick => tick.major).reduce<number | null>((best, tick) => {
      if (Math.abs(tick.position - ratio) > 0.025) return best;
      return best === null || Math.abs(tick.position - ratio) < Math.abs(model.ticks[best]?.position - ratio) ? model.ticks.indexOf(tick) : best;
    }, null);
    if (major !== null && major !== lastMajor.current) { lastMajor.current = major; navigator.vibrate?.(8); }
    if (ratio >= .96) onEndReachedRef.current?.();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType && event.pointerType !== 'touch') return;
    if (!metrics.long || hidden || total <= 1) return;
    cancelRelease();
    start.current = {x: event.clientX, y: event.clientY, pointerId: event.pointerId};
    lastMajor.current = null;
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
    if (!scrubbing.current) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD) return;
      if (Math.abs(dx) <= Math.abs(dy)) { start.current = null; return; }
      scrubbing.current = true;
      setPhase('active'); setHint(false);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    updateFromX(event.clientX);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    const wasScrubbing = scrubbing.current;
    if (wasScrubbing) event.currentTarget.releasePointerCapture?.(event.pointerId);
    start.current = null;
    finishRelease();
    // The idle band lies over the list: a plain tap belongs to whatever is underneath it.
    if (!wasScrubbing && origin && event.type === 'pointerup' && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD) forwardTap(event.currentTarget, event.clientX, event.clientY);
  };

  const visible = !hidden && metrics.long && total > 1;
  if (!visible && phase === 'idle' && !hint) return null;
  const label = model.labelAt(position.index);
  const scrubberStyle = {'--scrubber-progress': String(position.ratio)} as CSSProperties;
  return <div className={`mobile-scrubber${phase !== 'idle' ? ` is-${phase}` : ''}${fading ? ' is-fading' : ''}`} data-state={phase} style={scrubberStyle}>
    {phase !== 'idle' && <div className="mobile-scrubber-dim" style={{top:metrics.top, bottom:metrics.bottom}} aria-hidden="true"/>}
    {hint && phase === 'idle' && <div className="mobile-scrubber-hint" aria-hidden="true"><i style={{left:`${metrics.progress * 100}%`}}/></div>}
    {visible && <div className="mobile-scrubber-zone" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} aria-hidden="true"/>}
    {phase !== 'idle' && <>
      <div className="mobile-scrubber-bar" aria-hidden="true">
        <div className="mobile-scrubber-track" ref={trackRef}/>
        <div className="mobile-scrubber-fill"/>
        {model.ticks.map((tick, index) => <span key={`${tick.index}:${index}`} className={`mobile-scrubber-tick${tick.major ? ' is-major' : ''}`} style={{left:`calc(18px + (100% - 36px) * ${tick.position})`}}>{tick.major && tick.label && <b>{tick.label}</b>}</span>)}
        <i className="mobile-scrubber-thumb"/>
      </div>
      <div className="mobile-scrubber-bubble" style={{left:`calc(12px + (100% - 24px) * ${position.ratio})`}}>
        {label && <b>{label}</b>}
        <small>{position.index.toLocaleString()} / {total.toLocaleString()}</small>
      </div>
    </>}
  </div>;
}

function forwardTap(zone: HTMLElement, x: number, y: number) {
  const previous = zone.style.pointerEvents;
  zone.style.pointerEvents = 'none';
  const target = document.elementFromPoint?.(x, y);
  zone.style.pointerEvents = previous;
  if (target instanceof HTMLElement && !zone.contains(target)) target.click();
}
