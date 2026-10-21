import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FavoriteCharacters, LibraryGateway } from "../../library/types";
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
