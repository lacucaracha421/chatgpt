import {useLayoutEffect, useRef, useState, type TouchEvent} from 'react';
import {ChevronLeftIcon, ChevronRightIcon} from '@heroicons/react/24/outline';
import {HomeCalendar} from '../../src/home/HomeCalendar';
import type {HomeReleaseCard} from '../../src/home/HomeAttention';
import type {ReleaseCalendarModel} from '../../src/home/homeCalendarModel';
import {EASE_STANDARD, reducedMotion} from '../../src/shared/motion/curves';
import {IconButton} from '../ui';

const SWIPE_DISTANCE = 56;
const WEEK_MOTION_MS = 160;

/**
 * The shared two-week release model shown one week at a time: this week, then next week by arrow or swipe.
 * Rendering is the PC calendar's own, so titles, NEW, D-day and payments stay identical.
 */
export function TabletWeekStrip({model, at, onOpenCalendar, onOpenNote}: {model: ReleaseCalendarModel<HomeReleaseCard>; at: Date; onOpenCalendar(): void; onOpenNote(noteId: string): void}) {
  const [week, setWeek] = useState(0);
  const weeks = Math.max(1, Math.floor(model.days.length / 7));
  const touch = useRef<{x: number; y: number} | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const shownWeek = useRef(0);
  const move = (step: number) => setWeek(current => Math.max(0, Math.min(weeks - 1, current + step)));
  // The other week slides in from its own side using the shared text-only cells.
  useLayoutEffect(() => {
    const from = shownWeek.current;
    shownWeek.current = week;
    if (from === week || reducedMotion()) return;
    const animation = grid.current?.animate?.([{opacity: 0, transform: `translateX(${week > from ? 14 : -14}px)`}, {opacity: 1, transform: 'translateX(0)'}], {duration: WEEK_MOTION_MS, easing: EASE_STANDARD});
    return () => animation?.cancel();
  }, [week]);
  // The shown week restarts its grid at index 0, so its first day carries the month like the PC grid's first day.
  const shown = {...model, days: model.days.slice(week * 7, week * 7 + 7).map((day, index) => ({...day, index}))};
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const end = event.changedTouches[0];
    if (!start || !end) return;
    const dx = end.clientX - start.x, dy = end.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
  };
  return <div className="home-tablet-week" data-week={week}
    onTouchStart={event => { const point = event.touches[0]; touch.current = point ? {x: point.clientX, y: point.clientY} : null; }}
    onTouchEnd={onTouchEnd} onTouchCancel={() => { touch.current = null; }}>
    <div className="home-tablet-week__grid" ref={grid}>
      <HomeCalendar model={shown} at={at} onOpenCalendar={onOpenCalendar} onOpenNote={onOpenNote}
        extraActions={<span className="home-tablet-week__nav">
          <IconButton label="이전 주" icon={ChevronLeftIcon} disabled={week === 0} onClick={() => move(-1)} />
          <IconButton label="다음 주" icon={ChevronRightIcon} disabled={week >= weeks - 1} onClick={() => move(1)} />
        </span>} />
    </div>
  </div>;
}
