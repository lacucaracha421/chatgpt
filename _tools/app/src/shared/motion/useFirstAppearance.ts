import { useContext, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { AreaEntering, AreaVisible } from './AreaSwitch';
import { reducedMotion, springEasing } from './curves';
import { joinEntrance } from './entranceGroup';

/**
 * Each visit's first committed, painted batch; no motion for later virtual rows or queries.
 * A visit ends when the area is hidden, or when `visit` changes: a host that stays mounted
 * across places (a shelf whose folder changed, a gallery reached without a folder move) passes
 * the place it shows, so the new place's first batch enters like the first one did.
 * With `group`, the batch is held unseen on its first frame until the group's shared start
 * (entranceGroup.ts): its first-viewport images decoded, capped, in the same frame as the
 * group's other parts, so a list and its thumbnails read as one entrance.
 */
export function useFirstAppearance(host: RefObject<HTMLElement | null>, count: number, enabled = true, _key = 'asset-gallery', selector = '[data-asset-id]', visit?: unknown, group?: string) {
  const visible = useContext(AreaVisible);
  const areaEntering = useContext(AreaEntering);
  const consumed = useRef(false);
  const visited = useRef(visit);
  const animations = useRef<Animation[]>([]);
  const leave = useRef<(() => void) | null>(null);
  const stop = () => {
    leave.current?.(); leave.current = null;
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
  };
  useLayoutEffect(() => {
    if (!Object.is(visited.current, visit)) {
      visited.current = visit;
      consumed.current = false;
      stop();
    }
    if (!visible) {
      consumed.current = false;
      stop();
      return;
    }
    if (areaEntering) { consumed.current = true; return; }
    if (!enabled || consumed.current || !count || !host.current) return;
    const tiles = Array.from(host.current.querySelectorAll<HTMLElement>(selector));
    if (!tiles.length) return; // The virtualizer may not have measured its first viewport yet.
    consumed.current = true;
    if (reducedMotion()) return;
    const easing = springEasing();
    animations.current = tiles.flatMap((tile, index) => typeof tile.animate === 'function' ? [tile.animate(
      selector === '[data-asset-id]'
        ? [{opacity: 0, transform: 'translateY(8px) scale(.98)'}, {opacity: 1, transform: 'none'}]
        // A held part stays unseen (not faded) until its start: visibility flips as it begins to rise.
        : group ? [{visibility: 'hidden', transform: 'translateY(8px) scale(.98)'}, {visibility: 'visible', transform: 'none'}]
        : [{transform: 'translateY(8px) scale(.98)'}, {transform: 'none'}],
      {duration: 560, delay: Math.min(index, 18) * 24, easing, fill: 'backwards'},
    )] : []);
    if (group && animations.current.length) {
      const held = animations.current;
      held.forEach(animation => animation.pause?.());
      leave.current = joinEntrance(group, host.current, () => { leave.current = null; held.forEach(animation => animation.play?.()); });
    }
  });
  useEffect(() => {
    const element = host.current;
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const cancel = () => { if (query?.matches) stop(); };
    query?.addEventListener?.('change', cancel);
    return () => {
      query?.removeEventListener?.('change', cancel);
      // StrictMode replays effects on the same painted DOM; keep its first entrance running.
      if (!element?.isConnected) stop();
    };
  }, []);
}
