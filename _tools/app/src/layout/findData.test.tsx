import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Note, Snapshot } from "../notes/store";
import type { ArtistSummary } from "../artists/types";
import { useFindData } from "./findData";
const fixture = vi.hoisted(() => ({
  list: vi.fn(), load: vi.fn(), root: "one", state: {} as Snapshot, listeners: new Set<() => void>(),
}));
vi.mock("../library/LibraryContext", () => { const gateway = { artists: { list: fixture.list } }; return { useOptionalLibrary: () => ({ gateway, library: { root: fixture.root } }) }; });
vi.mock("../notes/store", () => ({ notesStore: () => ({ load: fixture.load, snapshot: () => fixture.state,
  subscribe: (fn: () => void) => { fixture.listeners.add(fn); return () => fixture.listeners.delete(fn); } }) }));
const note = (id = "n") => ({ id, title: "별과 메모", body: "NEVER INDEX", type: "secret", deleted: false } as Note);
const artist = (id: string) => ({ id, label: "별과 " + id, hidden: false, keys: [], assetCount: 1, coverAssetIds: [] } as unknown as ArtistSummary);
beforeEach(() => {
  fixture.root = "one";
  fixture.state = { ready: true, unlocked: true, notes: [note()], error: null } as Snapshot;
  fixture.list.mockReset().mockResolvedValue({ total: 1, artists: [artist("a")] });
  fixture.load.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
it("loads local sources only on open, paginates all artists and caches reads while typing", async () => {
  fixture.list.mockResolvedValueOnce({ total: 2, artists: [artist("a")] }).mockResolvedValueOnce({ total: 2, artists: [artist("b")] });
  const { result, rerender } = renderHook(({ open, query }) => { void query; return useFindData(open, [], vi.fn()); }, { initialProps: { open: false, query: "" } });
  expect(fixture.list).not.toHaveBeenCalled(); expect(fixture.load).not.toHaveBeenCalled();
  rerender({ open: true, query: "" });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.entries.map(entry => entry.id)).toEqual(["artist-a", "artist-b", "note-n"]);
  expect(fixture.list.mock.calls.map(([query]) => query.offset)).toEqual([0, 1]);
  rerender({ open: true, query: "ㅂㄱ" });
  expect(fixture.list).toHaveBeenCalledTimes(2); expect(fixture.load).toHaveBeenCalledOnce();
  expect(JSON.stringify(result.current.entries.map(({ id, label, context, keywords }) => ({ id, label, context, keywords })))).not.toContain("NEVER INDEX");
  rerender({ open: false, query: "" }); rerender({ open: true, query: "" });
  await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(3));
});
it("removes notes immediately on lock and resolves opening with the latest navigation callback", async () => {
  const first = vi.fn(); const next = vi.fn();
  const { result, rerender } = renderHook(({ navigate }) => useFindData(true, [], navigate), { initialProps: { navigate: first } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  rerender({ navigate: next }); result.current.entries.find(entry => entry.group === "note")?.run();
  expect(next).toHaveBeenCalledWith({ kind: "notes", noteId: "n" }); expect(first).not.toHaveBeenCalled();
  act(() => { fixture.state = { ...fixture.state, unlocked: false }; for (const fn of fixture.listeners) fn(); });
  expect(result.current.entries.some(entry => entry.group === "note")).toBe(false);
});
it("retains previous completed artist rows during a new read, reports failure, and isolates library changes", async () => {
  const { result, rerender } = renderHook(({ open }) => useFindData(open, [], vi.fn()), { initialProps: { open: true } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  let reject!: (reason: Error) => void;
  fixture.list.mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
  rerender({ open: false }); rerender({ open: true });
  expect(result.current.entries.some(entry => entry.id === "artist-a")).toBe(true);
  await act(async () => { reject(new Error("offline")); });
  expect(result.current.error).toContain("일부 이름");
  fixture.root = "two"; fixture.state = { ...fixture.state, unlocked: false };
  fixture.list.mockResolvedValue({ total: 0, artists: [] });
  rerender({ open: true });
  expect(result.current.entries).toEqual([]);
  await waitFor(() => expect(result.current.loading).toBe(false));
});
