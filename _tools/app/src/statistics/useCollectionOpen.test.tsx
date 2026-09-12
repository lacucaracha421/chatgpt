import { StrictMode, type PropsWithChildren } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { useCollectionOpen } from "./useCollectionOpen";

describe("collection open telemetry", () => {
  it("counts each detail once per uninterrupted session, including StrictMode replay", async () => {
    const recordCollectionOpened = vi.fn().mockResolvedValue(undefined);
    const gateway = { recordCollectionOpened } as unknown as LibraryGateway;
    const { rerender } = renderHook(({ root, id }: { root: string; id: string | null }) => useCollectionOpen(gateway, root, id), {
      initialProps: { root: "library-a", id: "a" as string | null },
      wrapper: ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>,
    });
    await waitFor(() => expect(recordCollectionOpened).toHaveBeenCalledTimes(1));
    rerender({ root: "library-a", id: "b" });
    await waitFor(() => expect(recordCollectionOpened).toHaveBeenCalledTimes(2));
    rerender({ root: "library-a", id: "a" });
    expect(recordCollectionOpened).toHaveBeenCalledTimes(2);
    rerender({ root: "library-a", id: null });
    rerender({ root: "library-a", id: "a" });
    await waitFor(() => expect(recordCollectionOpened).toHaveBeenCalledTimes(3));
    rerender({ root: "library-b", id: "a" });
    await waitFor(() => expect(recordCollectionOpened).toHaveBeenCalledTimes(4));
  });
  it("does not interrupt viewing if telemetry throws or is unavailable", async () => {
    const gateway = { recordCollectionOpened: vi.fn(() => { throw new Error("offline"); }) } as unknown as LibraryGateway;
    const { rerender } = renderHook(({ id }) => useCollectionOpen(gateway, "library", id), { initialProps: { id: "a" } });
    await waitFor(() => expect(gateway.recordCollectionOpened).toHaveBeenCalledOnce());
    rerender({ id: "a" });
    expect(gateway.recordCollectionOpened).toHaveBeenCalledOnce();
    renderHook(() => useCollectionOpen({} as LibraryGateway, "library", "b"));
  });
});
