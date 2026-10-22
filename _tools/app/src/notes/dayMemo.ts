/**
 * Day memos of Home's month calendar (HOME-CAL-001): one short memo per local date, kept as the
 * items of one hidden, archived checklist note per month. The note rides the existing encrypted
 * note sync (items merge per date), so there is no server store and no native change. Lists, Find
 * and the trash skip these notes (`isDayMemoNote`).
 */
import type { Note, NotesStore } from "./store";

export const DAY_MEMO_MAX_CHARS = 500;
const TITLE = /^달력 메모 (\d{4}-\d{2})$/;
const ORDER = "V";

export const dayMemoTitle = (month: string) => `달력 메모 ${month}`;
/** A hidden month note of day memos, by its type and title. */
export const isDayMemoNote = (note: { type?: string; title?: string }) => note.type === "checklist" && TITLE.test(note.title ?? "");

/** A UUID derived from the month, so two devices that start the same month converge on one note. */
export async function dayMemoId(month: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lakomics-day-memo:1:${month}`)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const monthNotes = (notes: Note[], month: string) => notes.filter(note => !note.deleted && isDayMemoNote(note) && note.title === dayMemoTitle(month));

/** Memo text by date for the given months. Keep-both copies of one month are merged, the newest copy winning. */
export function dayMemos(notes: Note[], months: string[]): Map<string, string> {
  const memos = new Map<string, string>();
  for (const month of months) {
    for (const note of monthNotes(notes, month).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      for (const item of note.items ?? []) {
        if (!item.id.startsWith(`${month}-`)) continue;
        if (item.text.trim()) memos.set(item.id, item.text); else memos.delete(item.id);
      }
    }
  }
  return memos;
}

/** Saves one day's memo (an empty text clears it). Typing coalesces through the store's debounce. */
export async function writeDayMemo(store: NotesStore, date: string, text: string): Promise<void> {
  const month = date.slice(0, 7);
  const id = await dayMemoId(month);
  const notes = store.snapshot().notes;
  const existing = notes.find(note => note.id === id && !note.deleted) ?? monthNotes(notes, month).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const value = text.slice(0, DAY_MEMO_MAX_CHARS);
  const items = (existing?.items ?? []).filter(item => item.id !== date);
  // A cleared day keeps an empty item while it still shows: it overrides that day in an older keep-both copy of the month.
  if (value.trim()) items.push({ id: date, text: value, checked: false, order: ORDER });
  else if (dayMemos(notes, [month]).has(date)) items.push({ id: date, text: "", checked: false, order: ORDER });
  if (!existing) {
    if (!items.length) return;
    const now = new Date().toISOString();
    store.edit({ id, type: "checklist", title: dayMemoTitle(month), body: "", items, labels: [], pinned: false, deleted: false, archived: true, concealed: false,
      createdAt: now, updatedAt: now, localRevision: 0, pending: true, conflict: false }, true);
    return;
  }
  store.edit({ ...existing, items }, true);
}
