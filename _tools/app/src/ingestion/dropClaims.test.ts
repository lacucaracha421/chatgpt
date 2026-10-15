import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { claimNativeDrop, nativeDropClaimed } from "./dropClaims";
import { useFileDrop, type DropSubscriber, type NativeFileDropEvent } from "./useFileDrop";

let release: (() => void) | undefined;
afterEach(() => { release?.(); release = undefined; });

function claimed() {
  const element = document.createElement("div");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  release = claimNativeDrop(element);
}

it("keeps a drop on a claimed element out of the library import and imports one elsewhere", async () => {
  claimed();
  expect(nativeDropClaimed({ x: 50, y: 50 })).toBe(true);
  expect(nativeDropClaimed({ x: 500, y: 500 })).toBe(false);
  let send!: (event: NativeFileDropEvent) => void;
  const subscribe: DropSubscriber = async (handler) => { send = handler; return () => undefined; };
  const ingestMedia = vi.fn().mockResolvedValue({ status: "exact_duplicate", existingAssetId: "x" });
  const { result } = renderHook(() => useFileDrop({ enabled: true, subscribe, classificationId: null, ingestMedia, onIngested: vi.fn(), onFatalError: vi.fn() }));
  await waitFor(() => expect(send).toBeDefined());
  act(() => send({ type: "enter", paths: ["C:\in\a.png"], position: { x: 50, y: 50 } }));
  expect(result.current.over).toBe(false);
  act(() => send({ type: "drop", paths: ["C:\in\a.png"], position: { x: 50, y: 50 } }));
  expect(ingestMedia).not.toHaveBeenCalled();
  act(() => send({ type: "enter", paths: ["C:\in\b.png"], position: { x: 500, y: 500 } }));
  expect(result.current.over).toBe(true);
  act(() => send({ type: "drop", paths: ["C:\in\b.png"], position: { x: 500, y: 500 } }));
  await waitFor(() => expect(ingestMedia).toHaveBeenCalledOnce());
});
