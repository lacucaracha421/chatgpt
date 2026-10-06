import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCharacterHub } from "./useCharacterHub";

const api = vi.hoisted(() => ({
  targets: vi.fn(), series: vi.fn(), folderExclusions: vi.fn(), allGroups: vi.fn(),
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
  api.folderExclusions.mockResolvedValue([]);
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
  api.folderExclusions.mockResolvedValue([]);
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
