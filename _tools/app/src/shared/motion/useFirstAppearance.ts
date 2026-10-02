import { useContext, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { AreaVisible, useAppearanceMemory } from './AreaSwitch';
import { reducedMotion, springEasing } from './curves';

/** Only the first committed, painted batch; no motion for later virtual rows or queries. */
export function useFirstAppearance(host: RefObject<HTMLElement | null>, count: number, enabled = true, key = 'asset-gallery', selector = '[data-asset-id]') {
  const memory = useAppearanceMemory();
  const visible = useContext(AreaVisible);
  const consumed = useRef(false);
  const animations = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    if (!enabled || !visible || consumed.current || !count || !host.current) return;
    const tiles = Array.from(host.current.querySelectorAll<HTMLElement>(selector));
    if (!tiles.length) return; // The virtualizer may not have measured its first viewport yet.
    consumed.current = true;
    if (memory?.has(key)) return;
    memory?.add(key);
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
