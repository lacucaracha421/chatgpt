import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject} from 'react';
import {buildScrubberModel, clampScrubberTag, scrubberIndexAt, scrubberRatioAt, thinScrubberLabels, type ScrubberSort} from './scrubberModel';
import './scrubber.css';

const DRAG_THRESHOLD = 8;
const HINT_MS = 1000;
const RELEASE_MS = 300;
/** A tap on the bottom band shows the bar this long without a drag. */
const SUMMON_MS = 2600;
const FADE_MS = 220;

type Metrics = {long: boolean; progress: number; top: number; bottom: number};

export function Scrubber({scrollRef, total, sort, hidden = false, onEndReached, onSeek, indexAtScroll}: {scrollRef: RefObject<HTMLElement | null>; total: number; sort: ScrubberSort; hidden?: boolean; onEndReached?(): void; onSeek?(index:number):void; indexAtScroll?():number}) {
  const sortValues = sort.kind === 'toc' ? sort.buckets : sort.kind === 'fallback' ? undefined : sort.values;
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
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [railWidth, setRailWidth] = useState(0);
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
      progress: indexAtScroll ? scrubberRatioAt(indexAtScroll(),total) : range > 0 ? Math.max(0, Math.min(1, element.scrollTop / range)) : scrubberRatioAt(positionRef.current.index, total),
      top: rect.top,
      bottom: Math.max(0, window.innerHeight - (rect.bottom || window.innerHeight)),
    });
  }, [hidden, scrollRef, total, indexAtScroll]);

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

  const scheduleHide = (delay: number) => {
    window.clearTimeout(releaseTimer.current); window.clearTimeout(fadeTimer.current);
    releaseTimer.current = window.setTimeout(() => {
      setFading(true);
      fadeTimer.current = window.setTimeout(() => { setPhase('idle'); setFading(false); }, FADE_MS);
    }, delay);
  };

  const finishRelease = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    setPhase('released');
    scheduleHide(RELEASE_MS);
  };

  /** Tap on the bottom band: show the bar at the current scroll position, ready to drag. */
  const summon = () => {
    const ratio = metrics.progress;
    setPosition({ratio, index: scrubberIndexAt(ratio, total)});
    setHint(false); setFading(false);
    setPhase('released');
    scheduleHide(SUMMON_MS);
  };

  const updateFromX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 20;
    const width = rect?.width || Math.max(1, window.innerWidth - 40);
    const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
    const index = scrubberIndexAt(ratio, total);
    const element = scrollRef.current;
    if (element && !onSeek) {
      element.scrollTop = ratio * Math.max(0, element.scrollHeight - element.clientHeight);
      measure();
    }
    positionRef.current={ratio,index};setPosition({ratio, index});
    const major = model.ticks.filter(tick => tick.major).reduce<number | null>((best, tick) => {
      if (Math.abs(tick.position - ratio) > 0.025) return best;
      return best === null || Math.abs(tick.position - ratio) < Math.abs(model.ticks[best]?.position - ratio) ? model.ticks.indexOf(tick) : best;
    }, null);
    if (major !== null && major !== lastMajor.current) { lastMajor.current = major; navigator.vibrate?.(8); }
    if (!onSeek && ratio >= .96) onEndReachedRef.current?.();
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
      // Once the bar is showing, any sideways-ish drag scrubs; from the idle band it must be clearly sideways.
      const shown = phase !== 'idle';
      if (Math.max(Math.abs(dx), Math.abs(dy)) < (shown ? 4 : DRAG_THRESHOLD)) return;
      if (!shown && Math.abs(dx) <= Math.abs(dy)) { start.current = null; return; }
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
    if(wasScrubbing && event.type==='pointerup')onSeek?.(positionRef.current.index);
    // A plain tap on the band summons the bar; a tap on the shown bar jumps there.
    if (!wasScrubbing && origin && event.type === 'pointerup' && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD) {
      if (phase === 'idle') summon();
      else { updateFromX(event.clientX); onSeek?.(positionRef.current.index); scheduleHide(SUMMON_MS); }
    }
  };

  // The track is the rail's full width, so the same width places the labels, the thumb and the floating label.
  const shown = phase !== 'idle';
  useLayoutEffect(() => {
    if (!shown && !hint) return;
    const update = () => setRailWidth(trackRef.current?.clientWidth || Math.max(1, window.innerWidth - 40));
    update();
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); };
  }, [shown, hint]);
  // Keep the small label above the thumb, inside the bar's ends.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const width = trackRef.current?.clientWidth || Math.max(1, window.innerWidth - 40);
    bubble.style.left = `${clampScrubberTag(width * position.ratio, width, bubble.offsetWidth)}px`;
  }, [position.ratio, position.index, phase, railWidth]);
  const marks = useMemo(() => {
    const width = railWidth || Math.max(1, window.innerWidth - 40);
    const labelled = model.ticks.filter(tick => tick.major && tick.label).map(tick => ({key: tick.index, label: tick.label as string, x: tick.position * width}));
    return thinScrubberLabels(labelled);
  }, [model.ticks, railWidth]);
  const visible = !hidden && metrics.long && total > 1;
  if (!visible && phase === 'idle' && !hint) return null;
  const label = model.labelAt(position.index);
  const ratio = phase === 'idle' ? metrics.progress : position.ratio;
  const scrubberStyle = {'--scrubber-progress': String(ratio)} as CSSProperties;
  return <div className={`mobile-scrubber${phase !== 'idle' ? ` is-${phase}` : ''}${fading ? ' is-fading' : ''}`} data-state={phase} style={scrubberStyle}>
    {phase !== 'idle' && <div className="mobile-scrubber-dim" style={{top:metrics.top, bottom:metrics.bottom}} aria-hidden="true"/>}
    {visible && <div className="mobile-scrubber-zone" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} aria-hidden="true"/>}
    {(hint || phase !== 'idle') && <div className="mobile-scrubber-rail" aria-hidden="true">
      <div className="mobile-scrubber-track" ref={trackRef}/>
      <div className="mobile-scrubber-fill"/>
      {phase !== 'idle' && <div className="mobile-scrubber-years">
        {marks.map(mark => <span key={mark.key} style={{left:mark.x}}>{mark.label}</span>)}
        {model.ticks.filter(tick => tick.major && !tick.label).map(tick => <i key={tick.index} style={{left:`${tick.position * 100}%`}}/>)}
      </div>}
      <i className="mobile-scrubber-thumb"/>
      {phase !== 'idle' && sort.kind==='toc' && model.ticks.filter(tick=>!tick.major).map(tick=><i className="mobile-scrubber-month" key={tick.index} style={{left:`${tick.position*100}%`}}/>)}
      {phase !== 'idle' && <div className="mobile-scrubber-bubble" ref={bubbleRef}>
        {label && <b>{label}</b>}
        <small>{(position.index + 1).toLocaleString()} / {total.toLocaleString()}</small>
      </div>}
    </div>}
  </div>;
}
