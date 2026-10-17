import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetView, ClassificationEntry } from "../library/types";
import type { CharacterTarget } from "../characters/api";
import type { CharacterGroup } from "../characters/hubApi";
import { loadRecentFolders, recentFolderCatalog, recentFolderId, recentFoldersStorageKey, recordRecentFolder, useRecentFolderHistory } from "./recentFolders";

const folder = (id: string, parentId: string | null = null): ClassificationEntry => ({ id, name: id, parentId, kind: "tag", iconKey: null, colorKey: null });
const openFolder = (id: string): AssetView => ({ kind: "classification", classificationId: id });
const base = { libraryRoot: "test-library", classifications: [folder("a"), folder("b"), folder("pin")], groups: [] as CharacterGroup[], targets: [] as CharacterTarget[], pinnedIds: ["pin"], ready: true, onOpen: vi.fn() };

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

it("retains bar order on reuse and evicts the least recently used entry at eight", () => {
  let visits = Array.from({ length: 8 }, (_, index) => ({ id: String(index), lastUsed: index }));
  visits = recordRecentFolder(visits, "0", 10);
  expect(visits.map(visit => visit.id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  visits = recordRecentFolder(visits, "new", 11);
  expect(visits.map(visit => visit.id)).toEqual(["new", "0", "2", "3", "4", "5", "6", "7"]);
});

it("ignores drill-through and records a dwell or immediate image action, excluding pins and broad scopes", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ view }) => useRecentFolderHistory({ ...base, view }), { initialProps: { view: openFolder("a") } });
  act(() => vi.advanceTimersByTime(2000));
  rerender({ view: openFolder("b") });
  act(() => vi.advanceTimersByTime(3000));
  expect(result.current.folders.map(entry => entry.id)).toEqual(["b"]);
  act(() => result.current.record(openFolder("a")));
  expect(result.current.folders.map(entry => entry.id)).toEqual(["a", "b"]);
  for (const view of [openFolder("pin"), { kind: "classification", classificationId: null }, { kind: "unsorted" }, { kind: "album", albumId: "album" }, { kind: "private_vault" }] as AssetView[]) {
    rerender({ view });
    act(() => { result.current.record(); vi.advanceTimersByTime(3000); });
  }
  expect(result.current.folders.map(entry => entry.id)).toEqual(["a", "b"]);
});

it("maps real characters, linked folders and group extras to the group row", () => {
  const group: CharacterGroup = { id: "g", seriesId: "series", name: "그룹", revision: 1, targetIds: ["hero"], extrasTargetId: "extras" };
  const targets = [{ id: "hero", linkedClassificationId: "hero-folder", seriesClassificationId: "series" }, { id: "extras", extrasGroupId: "g", seriesClassificationId: "series" }] as CharacterTarget[];
  for (const view of [openFolder("hero-folder"), { kind: "classification", classificationId: "series", characterId: "hero" }, { kind: "classification", classificationId: "series", characterId: "extras" }] as AssetView[]) {
    expect(recentFolderId(view, [group], targets)).toBe("character-group:g");
  }
  const catalog = recentFolderCatalog([folder("series")], [group], targets);
  expect(catalog.get("character-group:g")).toMatchObject({ name: "그룹", path: "series › 그룹", group: true, view: { characterGroupId: "g" } });
});

it("stores per library, follows renames by id, prunes deletion and pinning, and clears without a pending dwell resurrecting it", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ classifications, pinnedIds, libraryRoot }) => useRecentFolderHistory({ ...base, view: openFolder("a"), classifications, pinnedIds, libraryRoot }), {
    initialProps: { classifications: base.classifications, pinnedIds: [] as string[], libraryRoot: "one" },
  });
  act(() => { result.current.record(openFolder("a")); result.current.record(openFolder("b")); });
  rerender({ classifications: [{ ...folder("a"), name: "새 이름" }], pinnedIds: [], libraryRoot: "one" });
  expect(result.current.folders.map(entry => entry.name)).toEqual(["새 이름"]);
  expect(loadRecentFolders("one").map(entry => entry.id)).toEqual(["a"]);
  rerender({ classifications: base.classifications, pinnedIds: [], libraryRoot: "two" });
  expect(result.current.folders).toEqual([]);
  act(() => result.current.record());
  expect(loadRecentFolders("two").map(entry => entry.id)).toEqual(["a"]);
  rerender({ classifications: base.classifications, pinnedIds: ["a"], libraryRoot: "one" });
  expect(result.current.folders).toEqual([]);
  expect(loadRecentFolders("one")).toEqual([]);
  rerender({ classifications: base.classifications, pinnedIds: [], libraryRoot: "two" });
  act(() => result.current.clear());
  act(() => vi.advanceTimersByTime(3000));
  expect(loadRecentFolders("two")).toEqual([]);
});

it("does not erase saved groups before the character catalog arrives", () => {
  localStorage.setItem(recentFoldersStorageKey("test-library"), JSON.stringify([{ id: "character-group:g", lastUsed: 1 }]));
  const { result, rerender } = renderHook(({ groups }) => useRecentFolderHistory({ ...base, view: openFolder("a"), groups }), { initialProps: { groups: [] as CharacterGroup[] } });
  expect(loadRecentFolders("test-library")).toHaveLength(1);
  rerender({ groups: [{ id: "g", seriesId: "a", name: "그룹", revision: 1, targetIds: [] }] });
  expect(result.current.folders.map(entry => entry.name)).toEqual(["그룹"]);
  rerender({ groups: [] });
  expect(loadRecentFolders("test-library")).toEqual([]);
});
