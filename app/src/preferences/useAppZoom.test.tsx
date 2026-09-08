import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ setZoom: vi.fn().mockResolvedValue(undefined), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.isTauri }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: native.setZoom }) }));
import { useAppZoom } from "./useAppZoom";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("applies the saved zoom at mount and updates the native webview", async () => {
  const { rerender } = renderHook(({ zoom }) => useAppZoom(zoom), { initialProps: { zoom: 125 } });
  expect(native.setZoom).toHaveBeenLastCalledWith(1.25);
  rerender({ zoom: 100 });
  expect(native.setZoom).toHaveBeenLastCalledWith(1);
});

it("reports native failures instead of silently claiming zoom was applied", async () => {
  native.setZoom.mockRejectedValueOnce(new Error("permission denied"));
  const { result } = renderHook(() => useAppZoom(150));
  await waitFor(() => expect(result.current).toContain("적용하지 못했습니다"));
});
