import { useCallback, useEffect, useRef, useState } from "react";
import type { ChecklistItem } from "./model";

export const NOTE_UNDO_GROUP_MS = 600;
export type NoteUndoField = "title" | "body" | "checklist";
export type NoteUndoValue = string | ChecklistItem[];

type Step = { field: NoteUndoField; before: NoteUndoValue; after: NoteUndoValue; at: number };

function copyValue(value: NoteUndoValue): NoteUndoValue {
  return typeof value === "string" ? value : value.map((item) => ({ ...item }));
}

/** Local, per-open-note history. Applying a step is deliberately delegated to the caller. */
export function useNoteUndo(noteId: string | null, apply: (field: NoteUndoField, value: NoteUndoValue) => void) {
  const [version, setVersion] = useState(0);
  const past = useRef<Step[]>([]);
  const future = useRef<Step[]>([]);
  const activeNote = useRef(noteId);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const clear = useCallback(() => {
    past.current = [];
    future.current = [];
    setVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    activeNote.current = noteId;
    clear();
  }, [clear, noteId]);

  const record = useCallback((field: NoteUndoField, before: NoteUndoValue, after: NoteUndoValue) => {
    if (!activeNote.current || JSON.stringify(before) === JSON.stringify(after)) return;
    const now = Date.now();
    const current = past.current[past.current.length - 1];
    if (current && current.field === field && now - current.at <= NOTE_UNDO_GROUP_MS) {
      current.after = copyValue(after);
      current.at = now;
    } else {
      past.current.push({ field, before: copyValue(before), after: copyValue(after), at: now });
    }
    future.current = [];
    setVersion((value) => value + 1);
  }, []);

  const undo = useCallback(() => {
    const step = past.current.pop();
    if (!step) return false;
    future.current.push(step);
    applyRef.current(step.field, copyValue(step.before));
    setVersion((value) => value + 1);
    return true;
  }, []);

  const redo = useCallback(() => {
    const step = future.current.pop();
    if (!step) return false;
    past.current.push(step);
    applyRef.current(step.field, copyValue(step.after));
    setVersion((value) => value + 1);
    return true;
  }, []);

  void version;
  return { record, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0, clear };
}
