import {useCallback, type RefObject} from 'react';

/** Windowed lists keep their cell shells mounted; seek those shells, not the rendered covers. */
export function useScrubberList(scrollRef: RefObject<HTMLElement | null>, selector: string) {
  const onSeek = useCallback((index: number) => {
    const root = scrollRef.current;
    const cell = root?.querySelectorAll<HTMLElement>(selector)[index];
    if (!root || !cell) return;
    root.scrollTop += cell.getBoundingClientRect().top - root.getBoundingClientRect().top;
  }, [scrollRef, selector]);
  const indexAtScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return 0;
    const top = root.getBoundingClientRect().top;
    const cells = Array.from(root.querySelectorAll<HTMLElement>(selector));
    const index = cells.findIndex(cell => cell.getBoundingClientRect().bottom > top + 1);
    return index < 0 ? Math.max(0, cells.length - 1) : index;
  }, [scrollRef, selector]);
  return {onSeek, indexAtScroll};
}
