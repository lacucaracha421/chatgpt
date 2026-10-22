import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FavoriteCharacters, FavoriteCommand, LibraryGateway } from "../../library/types";
import { useFavoriteCharacters } from "./useFavoriteCharacters";

afterEach(() => { cleanup(); localStorage.clear(); });

it("rolls back a rejected link and removes it from the offline queue", async () => {
  const document: FavoriteCharacters = { version: 1, revision: 1, entries: [{ characterId: "manual-new", name: "名前", coverAssetId: "cover", coverY: 50, profile: {}, workIds: [], extraWorks: [] }] };
  const gateway = { favoriteCharacters: vi.fn().mockResolvedValue(document), changeFavoriteCharacters: vi.fn().mockRejectedValue({ code: "favoriteCharacterExists" }) } as unknown as LibraryGateway;
  const { result } = renderHook(() => useFavoriteCharacters(gateway, "test-library"));
  await waitFor(() => expect(result.current.document).toEqual(document));
  await act(async () => { expect(await result.current.change([{ op: "link", id: "manual-new", characterId: "asset-character" }])).toBe(false); });
  expect(result.current.document).toEqual(document);
  expect(result.current.error).toBeTruthy();
  expect(localStorage.getItem("lakomics.favoriteCharacters.v1:test-library:pending")).toBeNull();
  await act(async () => { await result.current.refresh(); });
  expect(gateway.changeFavoriteCharacters).toHaveBeenCalledTimes(1);
});

it("drops a refused batch so later edits still save, and sends a link on its own", async () => {
  const entry = { characterId: "manual-new", name: "名前", coverAssetId: null, coverY: 50, profile: {}, workIds: [], extraWorks: [] };
  const document: FavoriteCharacters = { version: 1, revision: 1, entries: [entry] };
  const queued: FavoriteCommand[] = [
    { op: "add", ids: ["full"] },
    { op: "link", id: "manual-new", characterId: "taken" },
    { op: "update", id: "manual-new", set: { coverY: 20 } },
  ];
  localStorage.setItem("lakomics.favoriteCharacters.v1:queue-library:pending", JSON.stringify(queued));
  const changeFavoriteCharacters = vi.fn().mockImplementation((commands: FavoriteCommand[]) => {
    if (commands.some(command => command.op === "link")) return Promise.reject({ code: "favoriteCharacterExists" });
    if (commands.some(command => command.op === "add")) return Promise.reject({ code: "cloud_object_key_conflict" });
    return Promise.resolve({ ...document, revision: 2, entries: [{ ...entry, coverY: 20 }] });
  });
  const gateway = { favoriteCharacters: vi.fn().mockResolvedValue(document), changeFavoriteCharacters } as unknown as LibraryGateway;
  const { result } = renderHook(() => useFavoriteCharacters(gateway, "queue-library"));
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(changeFavoriteCharacters.mock.calls.map(([commands]) => commands.map((command: FavoriteCommand) => command.op))).toEqual([["add"], ["link"], ["update"]]);
  expect(result.current.document?.entries).toEqual([{ ...entry, coverY: 20 }]);
  expect(localStorage.getItem("lakomics.favoriteCharacters.v1:queue-library:pending")).toBeNull();
});
