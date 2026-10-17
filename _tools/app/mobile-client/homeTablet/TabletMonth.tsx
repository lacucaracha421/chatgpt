import {useRef, type ComponentProps, type MouseEvent, type TouchEvent} from 'react';
import {HomeMonth} from '../../src/home/HomeMonth';
import {shiftMonth} from '../../src/home/homeMonthModel';

const SWIPE_DISTANCE = 56;
/** A second tap on the same day within this window opens it (the viewer's double-tap window). */
export const DOUBLE_TAP_MS = 300;

/**
 * The PC month calendar as it is, with a horizontal swipe that pages months like the ‹ › buttons (the same 56 px
 * and mostly-sideways rule the week strip used). Paging swaps the grid in one step, as on the PC.
 * A tap only selects the day (the host's `onSelect`, at once); a second tap on it within 300 ms opens it
 * (`onOpenDay`), and Enter on a focused day opens it too, so no sheet pops up on every touch.
 */
export function TabletMonth({onOpenDay, ...props}: Omit<ComponentProps<typeof HomeMonth>, 'onEnterPanel'> & {onOpenDay(date: string): void}) {
  const {month, onMonth} = props;
  const touch = useRef<{x: number; y: number} | null>(null);
  const lastTap = useRef<{date: string; at: number} | null>(null);
  // Runs after the grid's own click handler has selected the day, so the first tap never waits.
  const onClick = (event: MouseEvent) => {
    const date = (event.target as HTMLElement).closest<HTMLElement>('[data-day]')?.dataset.day;
    if (!date) return;
    const now = Date.now(), previous = lastTap.current;
    if (previous && previous.date === date && now - previous.at <= DOUBLE_TAP_MS) { lastTap.current = null; onOpenDay(date); }
    else lastTap.current = {date, at: now};
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const end = event.changedTouches[0];
    if (!start || !end) return;
    const dx = end.clientX - start.x, dy = end.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) onMonth(shiftMonth(month, dx < 0 ? 1 : -1));
  };
  return <div className="home-tablet-month" onClick={onClick}
    onTouchStart={event => { const point = event.touches[0]; touch.current = point ? {x: point.clientX, y: point.clientY} : null; }}
    onTouchEnd={onTouchEnd} onTouchCancel={() => { touch.current = null; }}>
    <HomeMonth {...props} onEnterPanel={onOpenDay} />
  </div>;
}
