import type { Note } from "../notes/store";

/** The one note Home's 빠른 메모 edits. It is a normal note, so the 메모 tab shows the same text. */
export const QUICK_MEMO_TITLE = "빠른 메모";
const ID_KEY = "lakomics.home.quick-memo.v1:";

export function readQuickMemoId(root: string): string | null {
  if (!root) return null;
  try { return localStorage.getItem(ID_KEY + root) || null; } catch { return null; }
}
export function writeQuickMemoId(root: string, id: string) {
  if (!root) return;
  try { localStorage.setItem(ID_KEY + root, id); } catch { /* Storage can be disabled; the title match finds the note again. */ }
}

const usable = (note: Note) => !note.deleted && (note.type ?? "text") === "text";

/**
 * The saved id first; when that note is gone (trashed, or a new device) the oldest plain note titled
 * 빠른 메모, so two devices converge on one note.
 */
export function findQuickMemo(notes: Note[], savedId: string | null): Note | null {
  const saved = savedId ? notes.find(note => note.id === savedId && usable(note)) : undefined;
  if (saved) return saved;
  return notes.filter(note => usable(note) && note.title.trim() === QUICK_MEMO_TITLE)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null;
}

/** A fresh quick memo; the first save creates it on the PC and the sync carries it to the tablet. */
export function newQuickMemo(body: string, now = new Date()): Note {
  const stamp = now.toISOString();
  return { id: crypto.randomUUID(), title: QUICK_MEMO_TITLE, body, pinned: false, deleted: false, createdAt: stamp, updatedAt: stamp, localRevision: 0, pending: true, conflict: false };
}
