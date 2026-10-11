/**
 * Notes board: sticky-note cards in a CSS grid. Cards in one row share the row's height (grid
 * stretch), fill the list in order left to right, and stop growing at 300px so opening or closing
 * the editor pane keeps their width; spare room stays empty on the right.
 */
import { memo } from "react";
import type { Note } from "./store";
import { NoteCard } from "./NoteCard";
import "./noteCard.css";
export { CardBody, NoteCard } from "./NoteCard";
export { previewLines } from "./NoteCard";

type MasonryProps = { notes: Note[]; all: Note[]; selected: string | null; onOpen: (id: string) => void };
/** One grid section of note cards. */
export const NoteMasonry = memo(function NoteMasonry({ notes, all, selected, onOpen }: MasonryProps) {
  return <div className="notes-masonry">
    {notes.map((note) => <NoteCard key={note.id} note={note} notes={all} selected={selected === note.id} onOpen={onOpen} />)}
  </div>;
});
