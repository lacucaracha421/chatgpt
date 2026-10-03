import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: bridge.invoke,
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  bridge.handlers.set(name, handler);
  return () => bridge.handlers.delete(name);
}) }));

const normal = { lightweight: false, autoEnterMinutes: null, closeToTray: true, restricted: false, hidden: false, trayAvailable: true };
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(840);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  bridge.invoke.mockResolvedValue(normal);
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  bridge.handlers.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

it.each(["pending", "processing"] as const)("updates a %s video caption on workload events without changing preparation", async (state) => {
  const { AssetGallery } = await import("./AssetGallery");
  const waiting = video(state);
  const ready = video("ready");
  const failed = video("failed");
  const image: AssetSummary = { ...waiting, id: "image", originalName: "image.png", media: { kind: "image" } };
  const items = [waiting, ready, failed, image];
  const retry = vi.fn();
  const { rerender } = render(<AssetGallery layout="masonry" items={items} onRetryVideo={retry} />);
  await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("workload_profile"));
  const tile = screen.getByRole("option", { name: `${state}.mp4` });
  expect(screen.getByRole("status")).toHaveTextContent("준비 중");

  act(() => bridge.handlers.get("workload://changed")!({ payload: { ...normal, lightweight: true, restricted: true } }));
  expect(screen.getByRole("status")).toHaveTextContent("가벼운 모드로 대기 중");
  expect(screen.getByRole("status")).toHaveClass("ui-badge");
  expect(screen.getByRole("img", { name: "ready.mp4" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "failed.mp4" })).toHaveTextContent("미리보기 준비 실패");
  expect(screen.getByRole("option", { name: "image.png" }).querySelector("[role=status]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(retry).toHaveBeenCalledWith(expect.objectContaining({ id: "failed" }));

  act(() => bridge.handlers.get("workload://changed")!({ payload: { ...normal, restricted: true } }));
  expect(screen.queryByText("가벼운 모드로 대기 중")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("일반 모드로 전환 중");
  act(() => bridge.handlers.get("workload://changed")!({ payload: normal }));
  expect(screen.getByRole("status")).toHaveTextContent("준비 중");
  expect(screen.getByRole("option", { name: `${state}.mp4` })).toBe(tile);
  // Only the two one-time startup reads; workload events must not invoke preparation.
  expect(bridge.invoke.mock.calls).toEqual([["performance_profile"], ["workload_profile"]]);

  rerender(<AssetGallery layout="masonry" items={items} onRetryVideo={retry} privacyMode />);
  expect(screen.queryByText("준비 중")).not.toBeInTheDocument();
  expect(screen.getAllByRole("status", { name: "비공개 모드" })).toHaveLength(items.length);
});

it("reads lightweight mode on first load and removes the waiting badge when a video becomes ready", async () => {
  bridge.invoke.mockResolvedValue({ ...normal, lightweight: true, restricted: true });
  const { AssetGallery } = await import("./AssetGallery");
  const waiting = video("pending");
  const { rerender } = render(<AssetGallery layout="justified" items={[waiting]} />);
  expect(await screen.findByText("가벼운 모드로 대기 중")).toBeInTheDocument();
  rerender(<AssetGallery layout="justified" items={[{ ...waiting, media: video("ready").media }]} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "pending.mp4" })).toBeInTheDocument();
});

function video(state: "pending" | "processing" | "ready" | "failed"): AssetSummary {
  return {
    id: state, title: null, originalName: `${state}.mp4`, byteSize: 10, width: 200, height: 200,
    collectedAt: "2026-09-29T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null,
    creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null,
    originalModifiedAt: null, media: { kind: "video", durationMs: 10_000, preparationState: state, scrubFrameCount: 0 },
  };
}
