import { useEffect, useReducer, useRef } from 'react';

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
const currentTime = () => new Date();

export function homeRevisitDay(at: Date = currentTime()): string {
  return new Date(at.getTime() + KST_MS).toISOString().slice(0, 10);
}

/** Refresh at KST midnight, and on resume after a suspended midnight timer. */
export function useHomeRevisitDay(now: () => Date = currentTime): string {
  const [, update] = useReducer((value: number) => value + 1, 0);
  const clock = useRef(now);
  clock.current = now;
  const day = homeRevisitDay(now());
  useEffect(() => {
    const at = clock.current().getTime();
    const delay = DAY_MS - ((at + KST_MS) % DAY_MS);
    const timer = window.setTimeout(update, delay);
    const resume = () => update();
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [day]);
  return day;
}
