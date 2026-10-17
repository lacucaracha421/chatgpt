import { describe, expect, it } from "vitest";
import { dayMemoId, dayMemoTitle, dayMemos, isDayMemoNote, writeDayMemo } from "./dayMemo";
import { hiddenLedgerMonths } from "./ledger/model";
import { NotesStore, type Note, type NotesRequest } from "./store";

const T = "2026-10-01T00:00:00Z";
const monthNote = (month: string, items: { id: string; text: string }[], extra: Partial<Note> = {}): Note => ({
  id: `memo-${month}`, type: "checklist", title: dayMemoTitle(month), body: "", pinned: false, deleted: false, archived: true, createdAt: T, updatedAt: T, localRevision: 1, pending: false, conflict: false,
  items: items.map(item => ({ ...item, checked: false, order: "V" })), ...extra,
});

/** In-memory backend: a save stores the draft as the note. */
function backend(initial: Note[]) {
  let notes = initial;
  const saves: Record<string, unknown>[] = [];
  const request = (async (op: string, input: Record<string, unknown>) => {
    if (op === "save") {
      const { expectedRevision, ...draft } = input;
      saves.push(draft);
      const saved = { ...(notes.find(n => n.id === draft.id) ?? {}), ...draft, localRevision: Number(expectedRevision) + 1, pending: true, deleted: false, createdAt: T, updatedAt: T, body: "", conflict: false } as Note;
      notes = [saved, ...notes.filter(n => n.id !== saved.id)];
      return saved;
    }
    return { unlocked: true, notes, lastSyncedAt: null };
  }) as NotesRequest;
  return { request, saves };
}

describe("day memos", () => {
  it("reads memos by date from the hidden month notes, the newest copy winning", () => {
    const old = monthNote("2026-10", [{ id: "2026-10-03", text: "예전" }, { id: "2026-10-04", text: "둘째" }]);
    const copy = monthNote("2026-10", [{ id: "2026-10-03", text: "새것" }], { id: "copy", updatedAt: "2026-10-02T00:00:00Z", conflictCopy: true });
    const memos = dayMemos([old, copy, monthNote("2026-11", [{ id: "2026-11-01", text: "다음 달" }])], ["2026-10"]);
    expect([...memos]).toEqual([["2026-10-03", "새것"], ["2026-10-04", "둘째"]]);
  });

  it("keeps these notes out of the notes list, Find and the trash like ledger month notes", () => {
    const hidden = monthNote("2026-10", []);
    const plain = { ...monthNote("2026-10", []), id: "plain", title: "달력 메모 아님", archived: false };
    expect(isDayMemoNote(hidden)).toBe(true);
    expect(isDayMemoNote(plain)).toBe(false);
    expect([...hiddenLedgerMonths([hidden, plain])]).toEqual([hidden.id]);
  });

  it("derives one stable UUID per month so two devices converge on one note", async () => {
    const october = await dayMemoId("2026-10");
    expect(october).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await dayMemoId("2026-10")).toBe(october);
    expect(await dayMemoId("2026-11")).not.toBe(october);
  });

  it("creates the hidden month note on the first memo, edits it in place and removes a cleared day", async () => {
    const fake = backend([]);
    const store = new NotesStore(fake.request);
    await store.load();
    await writeDayMemo(store, "2026-10-17", "엣지러너 1기 다시 보기");
    await store.flush();
    const created = store.snapshot().notes[0]!;
    expect(created).toMatchObject({ type: "checklist", title: "달력 메모 2026-10", archived: true, id: await dayMemoId("2026-10") });
    expect(dayMemos(store.snapshot().notes, ["2026-10"]).get("2026-10-17")).toBe("엣지러너 1기 다시 보기");

    await writeDayMemo(store, "2026-10-18", "둘째 날");
    await store.flush();
    expect(store.snapshot().notes.filter(isDayMemoNote)).toHaveLength(1);
    expect([...dayMemos(store.snapshot().notes, ["2026-10"]).keys()]).toEqual(["2026-10-17", "2026-10-18"]);

    await writeDayMemo(store, "2026-10-17", "  ");
    await store.flush();
    expect([...dayMemos(store.snapshot().notes, ["2026-10"]).keys()]).toEqual(["2026-10-18"]);
  });

  it("does not create a note for an empty memo", async () => {
    const fake = backend([]);
    const store = new NotesStore(fake.request);
    await store.load();
    await writeDayMemo(store, "2026-10-17", "");
    await store.flush();
    expect(fake.saves).toHaveLength(0);
  });
});
