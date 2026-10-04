import {useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {motionDefaults, motionTime, prefersReducedMotion} from '../src/shared/motion/curves';
import './fold.css';

const time = (element: Element, leaving: boolean) => prefersReducedMotion()
  ? motionTime('--motion-micro', motionDefaults.micro, element)
  : motionTime('--motion-medium', motionDefaults.medium, element) * (leaving ? .7 : 1);

/**
 * Fold contents. Opening unfolds them to their height (a 0fr → 1fr grid row) while they fade in;
 * closing folds them back in about 0.7× that time without taking input. A quick toggle reverses
 * from where it is. Folded away, the contents are removed, or only hidden with `keepMounted` (a
 * shelf keeps its covers and scroll position). Under reduced motion only the opacity changes.
 */
export function Fold({open, id, className, keepMounted = false, children}: {open: boolean; id?: string; className?: string; keepMounted?: boolean; children: ReactNode}) {
  const host = useRef<HTMLDivElement>(null);
  // Shown while open and while folding away; `settled` lets an open fold's contents overflow.
  const [present, setPresent] = useState(open);
  const [settled, setSettled] = useState(open);
  const last = useRef(open);
  useLayoutEffect(() => {
    if (last.current === open) return;
    last.current = open;
    const element = host.current;
    setSettled(false);
    if (open) {
      setPresent(true);
      if (!element) return;
      const done = window.setTimeout(() => setSettled(true), time(element, false));
      // A fold that was not on screen starts folded for its first frame, then unfolds.
      if (present) return () => window.clearTimeout(done);
      element.dataset.entering = '';
      void getComputedStyle(element).opacity;
      const frame = requestAnimationFrame(() => { delete element.dataset.entering; });
      return () => { window.clearTimeout(done); cancelAnimationFrame(frame); delete element.dataset.entering; };
    }
    if (!present || !element) return;
    const timer = window.setTimeout(() => setPresent(false), time(element, true));
    return () => window.clearTimeout(timer);
  }, [open]);// eslint-disable-line react-hooks/exhaustive-deps
  const shown = open || present;
  if (!shown && !keepMounted) return null;
  return <div ref={host} id={id} className={['tablet-fold', className].filter(Boolean).join(' ')} data-open={open} data-settled={open && settled || undefined}
    hidden={!shown || undefined} inert={!open || undefined} aria-hidden={!open || undefined}>
    <div className="tablet-fold__inner">{children}</div>
  </div>;
}
