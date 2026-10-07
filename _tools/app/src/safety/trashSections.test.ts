import { afterEach, expect, it, vi } from "vitest";
import { deletedTrashNotes, rememberedTrashSection, rememberTrashSection, trashTabs, trashExpiry, TRASH_SECTION_STORAGE_KEY } from "./trashSections";
import { LEDGER, LEDGER_MONTH } from "../notes/ledger/model";

afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(TRASH_SECTION_STORAGE_KEY); });

it("shares the section order and formatted nonzero counts", () => {
  expect(trashTabs({ assets: 1284, collections: 0, notes: 1 })).toEqual([
    { value: "assets", label: "에셋", count: "1,284" },
    { value: "collections", label: "컬렉션", count: undefined },
    { value: "notes", label: "메모", count: "1" },
  ]);
  expect(trashTabs({ collections: 500 }, { collections: true })[1].count).toBe("500+");
});

it("defaults to assets with invalid or unavailable storage", () => {
  localStorage.setItem(TRASH_SECTION_STORAGE_KEY, "old-section");
  expect(rememberedTrashSection()).toBe("assets");
  rememberTrashSection("notes");
  expect(rememberedTrashSection()).toBe("notes");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(rememberedTrashSection()).toBe("assets");
  expect(() => rememberTrashSection("collections")).not.toThrow();
});

it("uses shared calendar days for expiry wording", () => {
  const now = new Date("2026-10-07T12:00:00");
  expect(trashExpiry("2026-10-09", now)).toBe("2일 후 영구 삭제");
  expect(trashExpiry("2026-10-07", now)).toBe("곧 영구 삭제");
});

it("keeps hidden ledger months out of note rows and counts", () => {
  const notes = [
    { id: "note", deleted: true },
    { id: "live", deleted: false },
    { id: "ledger", deleted: true, type: LEDGER },
    { id: "month", deleted: true, type: LEDGER_MONTH, ledger: "ledger" },
  ];
  expect(deletedTrashNotes(notes).map(note => note.id)).toEqual(["note", "ledger"]);
});
