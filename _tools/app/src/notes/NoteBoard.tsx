/**
 * Notes board: masonry sticky-note cards (mobile design B, chosen 2026-09-26), adapted to the PC
 * notes area. Cards keep their content height and are placed in list order into the currently
 * shortest column, so the newest notes read left to right across the top and keyboard focus
 * follows the same order (a column-major CSS `columns` flow would bury later columns below
 * the fold on a long list).
 */
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { Note } from "./store";
import { NoteCard } from "./NoteCard";
import "./noteCard.css";
export { CardBody, NoteCard } from "./NoteCard";
export { previewLines } from "./NoteCard";

export const CARD_MIN_WIDTH = 240;
const CARD_MAX_WIDTH = 300;
export const CARD_GAP = 12;

/** Column count and card width for a board `width` px wide (0 = not measured yet). */
export function boardColumns(width: number, minWidth = CARD_MIN_WIDTH, gap = CARD_GAP) {
  if (width <= 0) return { columns: 0, cardWidth: 0 };
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  // Cards stop growing at CARD_MAX_WIDTH, so opening or closing the editor pane keeps their
  // width; spare room stays empty on the right (2026-09-28).
  return { columns, cardWidth: Math.min(CARD_MAX_WIDTH, (width - gap * (columns - 1)) / columns) };
}

/** Places cards in order into the shortest column (leftmost on ties). */
export function placeCards(heights: number[], columns: number, cardWidth: number, gap = CARD_GAP) {
  const bottoms = Array<number>(Math.max(1, columns)).fill(0);
  const positions = heights.map((height) => {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const position = { left: column * (cardWidth + gap), top: bottoms[column]! };
    bottoms[column] += height + gap;
    return position;
  });
  return { positions, height: Math.max(0, Math.max(...bottoms) - gap) };
}

type MasonryProps = { notes: Note[]; all: Note[]; selected: string | null; onOpen: (id: string) => void };
/** One masonry section. Before its width is known (first frame, tests) it falls back to a CSS grid. */
export const NoteMasonry = memo(function NoteMasonry({ notes, all, selected, onOpen }: MasonryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const { columns, cardWidth } = boardColumns(width);
  // Measure after every render (content, width or column changes); state only changes when a size did.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      setWidth((current) => (current === element.clientWidth ? current : element.clientWidth));
      const next: Record<string, number> = {};
      element.querySelectorAll<HTMLElement>(":scope > [data-note-id]").forEach((card) => { next[card.dataset.noteId!] = card.offsetHeight; });
      setHeights((current) => {
        const keys = Object.keys(next);
        return keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key]) ? current : next;
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll(":scope > [data-note-id]").forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  });
  const layout = columns ? placeCards(notes.map((note) => heights[note.id] ?? 160), columns, cardWidth) : null;
  return <div ref={ref} className={`notes-masonry${layout ? " is-placed" : ""}`} style={layout ? { height: layout.height } : undefined}>
    {notes.map((note, index) => <NoteCard key={note.id} note={note} notes={all} selected={selected === note.id} onOpen={onOpen}
      style={layout ? { width: cardWidth, transform: `translate(${layout.positions[index]!.left}px, ${layout.positions[index]!.top}px)` } : undefined} />)}
  </div>;
});
