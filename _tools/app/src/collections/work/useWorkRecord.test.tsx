import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { LibraryProvider } from "../../library/LibraryContext";
import type { CollectionSummary, LibraryGateway } from "../../library/types";
import { useWorkRecord } from "./useWorkRecord";

afterEach(cleanup);

it("reloads status and device after a collection refresh with unchanged summary fields", async () => {
  const before = { status: "playing", ownedPlatform: "PC", myScore: null, memo: null };
  const after = { ...before, status: "done", ownedPlatform: "PS5" };
  const getCollectionWorkRecord = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  const gateway = { getCollectionWorkRecord } as unknown as LibraryGateway;
  const collection = { id: "game", type: "game", myScore: null, description: null, updatedAt: "unchanged" } as CollectionSummary;
  const { result, rerender } = renderHook(({ item }) => useWorkRecord(item), {
    initialProps: { item: collection },
    wrapper: ({ children }: { children: ReactNode }) => <LibraryProvider gateway={gateway}>{children}</LibraryProvider>,
  });
  await waitFor(() => expect(result.current.record).toEqual(before));
  rerender({ item: { ...collection } });
  await waitFor(() => expect(result.current.record).toEqual(after));
});
