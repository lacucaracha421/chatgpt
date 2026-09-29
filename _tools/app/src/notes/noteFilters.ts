import { LEDGER } from "./ledger/model";
import type { NoteKind } from "./model";

export type NoteKindFilter = "all" | NoteKind | typeof LEDGER;
export const NOTE_KIND_DEFINITIONS: readonly [Exclude<NoteKindFilter, "all">, string][] = [
  ["text", "메모"],
  ["checklist", "체크리스트"],
  [LEDGER, "가계부"],
  ["secret", "암호"],
];
