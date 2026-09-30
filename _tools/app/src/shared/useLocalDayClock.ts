import { useEffect, useReducer, useRef } from "react";

const currentTime = () => new Date();

/** One wake-up at the next local midnight; calendar arithmetic also handles DST. */
export function useLocalDayClock(now: () => Date = currentTime): Date {
  const [, update] = useReducer((value: number) => value + 1, 0);
  const clock = useRef(now);
  clock.current = now;
  const at = now();
  const day = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
  useEffect(() => {
    const current = clock.current();
    const next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
    const timer = window.setTimeout(update, Math.max(1, next.getTime() - current.getTime()));
    return () => window.clearTimeout(timer);
  }, [day]);
  return at;
}
