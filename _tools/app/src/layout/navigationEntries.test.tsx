import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNavigationEntries } from "./navigationEntries";
import { setCollectionTrashCount } from "../safety/trashCounts";

const fixture = vi.hoisted(() => ({
  notes: [{ id: "deleted", deleted: true }, { id: "live", deleted: false }],
  listeners: new Set<() => void>(),
  load: vi.fn(),
}));
vi.mock("../library/LibraryContext", () => ({ useOptionalLibrary: () => ({ library: { root: "trash-count-test" } }) }));
vi.mock("../notes/store", () => ({ notesStore: () => ({
  snapshot: () => ({ notes: fixture.notes }),
  subscribe: (listener: () => void) => { fixture.listeners.add(listener); return () => { fixture.listeners.delete(listener); }; },
  load: fixture.load,
}) }));

afterEach(() => { cleanup(); setCollectionTrashCount("trash-count-test", 0); });

it("adds only already-known collection and note counts to the shared More/Find entry", () => {
  const { result } = renderHook(() => useNavigationEntries({ view: { kind: "trash" }, onNavigate: vi.fn(), reviewCount: 0, unsortedCount: 0, trashCount: 4, privateVaultAvailable: false }));
  const count = () => result.current.find(entry => entry.id === "trash")?.count;
  expect(count()).toBe(5);
  act(() => { setCollectionTrashCount("trash-count-test", 2); });
  expect(count()).toBe(7);
  act(() => { fixture.notes[0].deleted = false; fixture.listeners.forEach(listener => listener()); });
  expect(count()).toBe(6);
  expect(fixture.load).not.toHaveBeenCalled();
});
