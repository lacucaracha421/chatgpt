import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCharacterHub } from "./useCharacterHub";

const api = vi.hoisted(() => ({
  targets: vi.fn(), series: vi.fn(), folderExclusions: vi.fn(), groups: vi.fn(),
}));
vi.mock("./api", () => ({ characterApi: { targets: api.targets } }));
vi.mock("./hubApi", () => ({ characterHubApi: api }));
vi.mock("../library/LibraryContext", () => ({ useOptionalLibrary: () => null }));
vi.mock("./suggestions/client", () => ({ CHARACTER_SUGGESTIONS_CHANGED_EVENT: "test:character-change" }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

it("shares an in-flight StrictMode read and reads groups once per distinct series, then refreshes", async () => {
  let finish!: (targets: []) => void;
  api.targets.mockReturnValueOnce(new Promise<[]>(resolve => { finish = resolve; })).mockResolvedValue([]);
  api.series.mockResolvedValue([{ classificationId: "series" }, { classificationId: "series" }]);
  api.folderExclusions.mockResolvedValue([]);
  api.groups.mockResolvedValue([{ id: "group", seriesId: "series", targetIds: [], name: "Group", revision: 1 }]);
  const { result, rerender } = renderHook(({ version }) => useCharacterHub(version), {
    initialProps: { version: 0 },
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
  expect(api.targets).toHaveBeenCalledTimes(1);
  await act(async () => finish([]));
  await waitFor(() => expect(result.current.groups).toHaveLength(1));
  expect(api.groups).toHaveBeenCalledTimes(1);
  rerender({ version: 1 });
  expect(result.current.groups).toHaveLength(1);
  await waitFor(() => expect(api.groups).toHaveBeenCalledTimes(2));
});

it("does not issue group reads for a snapshot superseded while targets were pending", async () => {
  let finish!: (targets: []) => void;
  api.targets.mockReturnValueOnce(new Promise<[]>(resolve => { finish = resolve; })).mockResolvedValue([]);
  api.series.mockResolvedValue([{ classificationId: "series" }]);
  api.folderExclusions.mockResolvedValue([]);
  api.groups.mockResolvedValue([]);
  const { rerender } = renderHook(({ version }) => useCharacterHub(version), { initialProps: { version: 0 } });
  rerender({ version: 1 });
  await waitFor(() => expect(api.groups).toHaveBeenCalledTimes(1));
  await act(async () => finish([]));
  expect(api.groups).toHaveBeenCalledTimes(1);
});
