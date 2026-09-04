import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetGallery } from "./AssetGallery";

beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 900 },
    clientWidth: { configurable: true, get: () => 840 },
    offsetHeight: { configurable: true, get: () => 600 },
    clientHeight: { configurable: true, get: () => 600 },
    setPointerCapture: { configurable: true, value: vi.fn() },
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function asset(index: number): AssetSummary {
  return {
    id: `asset-${index}`, title: null, originalName: `asset-${index}.png`, byteSize: 1,
    width: 200, height: 200, collectedAt: "2026-07-30T00:00:00Z", favorite: false,
    sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null,
    creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null,
    media: { kind: "image" },
  };
}

function failedVideoAsset(): AssetSummary {
  return {
    ...asset(0),
    id: "video-0",
    originalName: "video-0.webm",
    media: { kind: "video", durationMs: 10_000, preparationState: "failed", scrubFrameCount: 0 },
  };
}

describe("failed video retry isolation", () => {
  it("clicking retry calls retry without selecting, opening, or dragging the tile", async () => {
    const onRetryVideo = vi.fn();
    const onSelectionGesture = vi.fn();
    const onOpen = vi.fn();
    const onPointerDragStart = vi.fn();
    render(
      <AssetGallery
        items={[failedVideoAsset()]}
        onRetryVideo={onRetryVideo}
        onSelectionGesture={onSelectionGesture}
        onOpen={onOpen}
        onPointerDragStart={onPointerDragStart}
      />,
    );
    const button = await waitFor(() => screen.getByRole("button", { name: "다시 시도" }));

    fireEvent.pointerDown(button, { button: 0 });
    fireEvent.click(button);

    expect(onRetryVideo).toHaveBeenCalledOnce();
    expect(onSelectionGesture).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onPointerDragStart).not.toHaveBeenCalled();
  });

  it("clicking the tile outside the retry button still selects normally", async () => {
    const onRetryVideo = vi.fn();
    const onSelectionGesture = vi.fn();
    render(
      <AssetGallery
        items={[failedVideoAsset()]}
        onRetryVideo={onRetryVideo}
        onSelectionGesture={onSelectionGesture}
      />,
    );
    const tile = await waitFor(() => screen.getByRole("option", { name: "video-0.webm" }));

    fireEvent.click(tile);

    expect(onSelectionGesture).toHaveBeenCalledOnce();
    expect(onRetryVideo).not.toHaveBeenCalled();
  });

  it("activating retry from the keyboard retries without opening the tile", async () => {
    const user = userEvent.setup();
    const onRetryVideo = vi.fn();
    const onOpen = vi.fn();
    render(
      <AssetGallery
        items={[failedVideoAsset()]}
        onRetryVideo={onRetryVideo}
        onOpen={onOpen}
      />,
    );
    const button = await waitFor(() => screen.getByRole("button", { name: "다시 시도" }));

    button.focus();
    await user.keyboard("{Enter}");

    expect(onRetryVideo).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });
});