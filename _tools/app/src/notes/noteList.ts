import { matchesKoreanSearch } from "../shared/koreanSearch";
import { isLedgerKind } from "./ledger/model";
import { isSecret, type Note } from "./store";

/** Search visible note fields; protected and ledger content matches by title only. */
export function noteMatches(note: Note, query: string): boolean {
  if (!query) return true;
  const text = isSecret(note) || isLedgerKind(note) || note.concealed
    ? note.title
    : [note.title, note.body, ...(note.items ?? []).map((item) => item.text), ...(note.labels ?? [])].join("\n");
  return matchesKoreanSearch(text, query);
}

/** Pinned notes first, then newest edit first. */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}
