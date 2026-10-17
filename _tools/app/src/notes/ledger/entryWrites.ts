/**
 * Month-note writes of the 가계부 entries, shared by the 메모 ledger screen and Home's day panel.
 * Every save checks the item limits and the whole-note size first (design §4.4); `report` receives
 * the message to show (null clears it).
 */
import type { Note, NotesStore } from "../store";
import { keyBetween } from "../model";
import { ledgerLimitProblem, ledgerSizeProblem, sortRecurring, type LedgerEntry, type Planned, type Recurring } from "./model";
import { ledgerEntries, monthCharges, monthNotesOf } from "./summary";

export type EntryDraft = { date: string; amount: number; name: string; in: boolean };

/** The order key that puts a new recurring/planned item after the existing ones. */
export function orderAfter<T extends Recurring | Planned>(list: T[]): string {
  const sorted = sortRecurring(list);
  return keyBetween(sorted.length ? sorted[sorted.length - 1]!.order : null, null);
}

export const ledgerSaveProblem = (note: Note) => ledgerLimitProblem(note) ?? ledgerSizeProblem(note);

export function ledgerWriter(store: NotesStore, ledgerId: string, report: (message: string | null) => void) {
  const freshMonthNotes = () => monthNotesOf(store.snapshot().notes, ledgerId);

  /** Writes the month note of `month` (created on first write; its id is derived natively). */
  async function saveMonth(month: string, update: (list: LedgerEntry[]) => LedgerEntry[], extra: Partial<Note> = {}): Promise<boolean> {
    try {
      const id = await store.ledgerMonth(ledgerId, month);
      // Finish the initial empty-month save before writing its first entry.
      if (!await store.flush()) { report(store.snapshot().error ?? "가계부 기록을 저장하지 못했습니다."); return false; }
      const note = store.snapshot().notes.find((n) => n.id === id);
      if (!note) return false;
      const next = { ...note, ...extra, entries: update(note.entries ?? []) };
      const problem = ledgerSaveProblem(next);
      report(problem);
      if (problem) return false;
      store.edit(next);
      return true;
    } catch (e) { report(typeof e === "string" ? e : "가계부 기록을 저장하지 못했습니다."); return false; }
  }

  /** Every month note holding the entry (keep-both copies repeat entries); nothing is saved if any would break a limit. */
  function editContaining(id: string, update: (list: LedgerEntry[]) => LedgerEntry[]): boolean {
    const next = freshMonthNotes().filter((note) => (note.entries ?? []).some((e) => e.id === id)).map((note) => ({ ...note, entries: update(note.entries ?? []) }));
    const problem = next.map(ledgerSaveProblem).find(Boolean) ?? null;
    report(problem);
    if (problem) return false;
    for (const note of next) store.edit(note);
    return true;
  }

  function addEntry(draft: EntryDraft, extra: Partial<LedgerEntry> = {}) {
    const entry: LedgerEntry = { id: crypto.randomUUID(), date: draft.date, amount: draft.amount, name: draft.name, createdAt: new Date().toISOString(), ...(draft.in ? { in: true } : {}), ...extra };
    return saveMonth(draft.date.slice(0, 7), (list) => {
      if (entry.recurring) {
        // Recheck after the asynchronous month creation/flush, including moved confirmations.
        const all = ledgerEntries(freshMonthNotes());
        const link = entry.recurring;
        if (all.some(e => e.recurring?.id === link.id && e.recurring.date === link.date)) return list;
        const current = store.snapshot().notes.find(n => n.id === ledgerId);
        if (monthCharges(current?.recurring ?? [], all, link.date.slice(0, 7)).some(c => c.recurring.id === link.id && c.date === link.date && c.confirmedBy)) return list;
      }
      return [...list, entry];
    });
  }

  async function updateEntry(old: LedgerEntry, draft: EntryDraft): Promise<boolean> {
    const next: LedgerEntry = { ...old, date: draft.date, amount: draft.amount, name: draft.name };
    if (draft.in) next.in = true; else delete next.in;
    const target = draft.date.slice(0, 7);
    if (target === old.date.slice(0, 7)) return editContaining(old.id, (list) => list.map((e) => (e.id === old.id ? next : e)));
    // Moving months: write the target first, then remove the entry from the source (design §4.2).
    if (!await saveMonth(target, (list) => [...list.filter((e) => e.id !== old.id), next])) return false;
    for (const note of freshMonthNotes()) if (note.month !== target && (note.entries ?? []).some((e) => e.id === old.id)) store.edit({ ...note, entries: (note.entries ?? []).filter((e) => e.id !== old.id) });
    return true;
  }

  /** Adds something to buy (no month = 언젠가) to the ledger note itself. */
  function addPlan(draft: { name: string; amount: number }): boolean {
    const current = store.snapshot().notes.find((n) => n.id === ledgerId);
    if (!current) return false;
    const list = current.planned ?? [];
    const next = { ...current, planned: [...list, { id: crypto.randomUUID(), order: orderAfter(list), name: draft.name, amount: draft.amount, month: null, memo: "", dropped: false } as Planned] };
    const problem = ledgerSaveProblem(next);
    report(problem);
    if (problem) return false;
    store.edit(next);
    return true;
  }

  const removeEntry = (id: string) => editContaining(id, (list) => list.filter((e) => e.id !== id));
  /** Puts a removed entry back with its own id and creation time. */
  const restoreEntry = (entry: LedgerEntry) => saveMonth(entry.date.slice(0, 7), (list) => [...list.filter((e) => e.id !== entry.id), entry]);

  return { freshMonthNotes, saveMonth, editContaining, addEntry, updateEntry, removeEntry, restoreEntry, addPlan };
}
