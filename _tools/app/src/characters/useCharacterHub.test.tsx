import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCharacterHub } from "./useCharacterHub";

const api = vi.hoisted(() => ({
  targets: vi.fn(), series: vi.fn(), allGroups: vi.fn(), reorderGroups: vi.fn(),
}));
vi.mock("./api", () => ({ characterApi: { targets: api.targets } }));
vi.mock("./hubApi", () => ({ characterHubApi: api }));
vi.mock("../library/LibraryContext", () => ({ useOptionalLibrary: () => null }));
vi.mock("./suggestions/client", () => ({ CHARACTER_SUGGESTIONS_CHANGED_EVENT: "test:character-change" }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

it("shares an in-flight StrictMode read, reads every group in one call, then refreshes", async () => {
  let finish!: (targets: []) => void;
  api.targets.mockReturnValueOnce(new Promise<[]>(resolve => { finish = resolve; })).mockResolvedValue([]);
  api.series.mockResolvedValue([{ classificationId: "series" }, { classificationId: "other" }]);
  api.allGroups.mockResolvedValue([{ id: "group", seriesId: "series", targetIds: [], name: "Group", revision: 1 }]);
  const { result, rerender } = renderHook(({ version }) => useCharacterHub(version), {
    initialProps: { version: 0 },
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
  expect(api.targets).toHaveBeenCalledTimes(1);
  await act(async () => finish([]));
  await waitFor(() => expect(result.current.groups).toHaveLength(1));
  expect(api.allGroups).toHaveBeenCalledTimes(1);
  const groups = result.current.groups;
  rerender({ version: 1 });
  await waitFor(() => expect(api.allGroups).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); });
  // The same data keeps its identity, so folder caches keyed on it are not dropped.
  expect(result.current.groups).toBe(groups);
});

it("counts analysed series without re-reading the hub", async () => {
  api.targets.mockResolvedValue([]);
  api.series.mockResolvedValue([]);
  api.allGroups.mockResolvedValue([]);
  const { result } = renderHook(() => useCharacterHub(0));
  await waitFor(() => expect(api.allGroups).toHaveBeenCalledTimes(1));
  act(() => result.current.seriesAnalysed(["a", "b"]));
  act(() => result.current.seriesAnalysed(["a"]));
  expect(result.current.seriesRevisions).toEqual({ a: 2, b: 1 });
  expect(result.current.revision).toBe(0);
  await act(async () => { await Promise.resolve(); });
  expect(api.targets).toHaveBeenCalledTimes(1);
});

it("keeps 기타 buckets apart from the characters every other screen lists", async () => {
  const character = { id: "hina", role: "character" };
  const legacy = { id: "old" };
  const extras = { id: "extras", role: "extras", extrasGroupId: null };
  api.targets.mockResolvedValue([character, legacy, extras]);
  api.series.mockResolvedValue([]);
  api.allGroups.mockResolvedValue([]);
  const { result } = renderHook(() => useCharacterHub(0));
  await waitFor(() => expect(result.current.extras).toEqual([extras]));
  // Data without a role (older hosts) is a character.
  expect(result.current.targets).toEqual([character, legacy]);
});

it("shows a chosen group order at once, keeps it over later reads, and puts the old order back when storing fails", async () => {
  const groups = [
    { id: "a", seriesId: "s", targetIds: [], name: "A", revision: 1 },
    { id: "b", seriesId: "s", targetIds: [], name: "B", revision: 1 },
    { id: "x", seriesId: "t", targetIds: [], name: "X", revision: 1 },
  ];
  api.targets.mockResolvedValue([]);
  api.series.mockResolvedValue([]);
  api.allGroups.mockResolvedValue(groups);
  let finish!: () => void, fail!: (error: unknown) => void;
  api.reorderGroups
    .mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }))
    .mockReturnValueOnce(new Promise<void>((_resolve, reject) => { fail = reject; }));
  const { result } = renderHook(() => useCharacterHub(0));
  await waitFor(() => expect(result.current.groups).toHaveLength(3));
  const ids = () => result.current.groups.map(group => group.id);
  let first!: Promise<void>;
  act(() => { first = result.current.reorderGroups("s", ["b", "a"]); });
  // Before the command has answered, the new order is already on screen; the other series stays put.
  expect(ids()).toEqual(["b", "a", "x"]);
  expect(api.reorderGroups).toHaveBeenCalledWith("s", ["b", "a"]);
  await act(async () => { finish(); await first; });
  await waitFor(() => expect(api.allGroups).toHaveBeenCalledTimes(2));
  // A read that still lists the old order does not undo it.
  expect(ids()).toEqual(["b", "a", "x"]);
  let second!: Promise<void>;
  act(() => { second = result.current.reorderGroups("s", ["a", "b"]).catch(() => undefined); });
  expect(ids()).toEqual(["a", "b", "x"]);
  await act(async () => { fail(new Error("stale")); await second; });
  expect(ids()).toEqual(["b", "a", "x"]);
});
