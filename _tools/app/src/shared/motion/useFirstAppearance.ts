import { useContext, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { AreaEntering, AreaVisible } from './AreaSwitch';
import { reducedMotion, springEasing } from './curves';

/** Each visit's first committed, painted batch; no motion for later virtual rows or queries. */
export function useFirstAppearance(host: RefObject<HTMLElement | null>, count: number, enabled = true, _key = 'asset-gallery', selector = '[data-asset-id]') {
  const visible = useContext(AreaVisible);
  const areaEntering = useContext(AreaEntering);
  const consumed = useRef(false);
  const animations = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    if (!visible) {
      consumed.current = false;
      animations.current.forEach(animation => animation.cancel());
      animations.current = [];
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
        : [{transform: 'translateY(8px) scale(.98)'}, {transform: 'none'}],
      {duration: 560, delay: Math.min(index, 18) * 24, easing, fill: 'backwards'},
    )] : []);
  });
  useEffect(() => {
    const element = host.current;
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const cancel = () => { if (query?.matches) animations.current.forEach(animation => animation.cancel()); };
    query?.addEventListener?.('change', cancel);
    return () => {
      query?.removeEventListener?.('change', cancel);
      // StrictMode replays effects on the same painted DOM; keep its first entrance running.
      if (!element?.isConnected) animations.current.forEach(animation => animation.cancel());
    };
  }, []);
}
