import { displayCount, daysUntil } from "../shared/displayDate";
import { hiddenLedgerMonths } from "../notes/ledger/model";

export const TRASH_SECTIONS = [
  { value: "assets", label: "에셋" },
  { value: "collections", label: "컬렉션" },
  { value: "notes", label: "메모" },
] as const;
export type TrashSection = typeof TRASH_SECTIONS[number]["value"];
export const TRASH_SECTION_STORAGE_KEY = "lakomics.trash.section";
export const TRASH_EMPTY = "휴지통이 비어 있습니다";

/** Ledger months remain inside their ledger, including when it is deleted. */
export function deletedTrashNotes<T extends { id: string; deleted: boolean; type?: string; ledger?: string }>(notes: readonly T[]): T[] {
  const hidden = hiddenLedgerMonths(notes);
  return notes.filter(note => note.deleted && !hidden.has(note.id));
}

export function trashTabs(counts: Partial<Record<TrashSection, number>>, hasMore: Partial<Record<TrashSection, boolean>> = {}) {
  return TRASH_SECTIONS.map(tab => ({ ...tab, count: (counts[tab.value] ?? 0) > 0 ? `${displayCount(counts[tab.value]!)}${hasMore[tab.value] ? "+" : ""}` : undefined }));
}

export function rememberedTrashSection(): TrashSection {
  try {
    const saved = localStorage.getItem(TRASH_SECTION_STORAGE_KEY);
    return TRASH_SECTIONS.find(tab => tab.value === saved)?.value ?? "assets";
  } catch { return "assets"; }
}

export function rememberTrashSection(section: TrashSection) {
  try { localStorage.setItem(TRASH_SECTION_STORAGE_KEY, section); } catch { /* Storage may be unavailable. */ }
}

export function trashExpiry(purgeAt: string, now = new Date()): string {
  const days = daysUntil(purgeAt, now);
  return days !== null && days > 0 ? `${displayCount(days)}일 후 영구 삭제` : "곧 영구 삭제";
}
