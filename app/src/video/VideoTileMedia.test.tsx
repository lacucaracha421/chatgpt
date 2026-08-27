import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { AssetSummary } from "../library/types";
import { VideoTileMedia } from "./VideoTileMedia";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("attaches muted playback after 200ms and fully cleans it up", () => {
  const request = vi.fn();
  const release = vi.fn();
  const { container, rerender } = render(<VideoTileMedia asset={video()} active={false} onRequestActive={request} onReleaseActive={release} onRetry={vi.fn()} />);
  fireEvent.pointerEnter(container.querySelector(".video-tile")!);
  vi.advanceTimersByTime(199);
  expect(request).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(request).toHaveBeenCalledOnce();

  rerender(<VideoTileMedia asset={video()} active onRequestActive={request} onReleaseActive={release} onRetry={vi.fn()} />);
  const media = screen.getByLabelText("clip.webm 미리보기") as HTMLVideoElement;
  expect(media.muted).toBe(true);
  expect(media.play).toHaveBeenCalledOnce();
  fireEvent.pointerLeave(container.querySelector(".video-tile")!);
  expect(release).toHaveBeenCalledOnce();
  rerender(<VideoTileMedia asset={video()} active={false} onRequestActive={request} onReleaseActive={release} onRetry={vi.fn()} />);
  expect(media.pause).toHaveBeenCalledOnce();
  expect(media.load).toHaveBeenCalledOnce();
  expect(media.getAttribute("src")).toBeNull();
});

it("decodes the still thumbnail asynchronously", () => {
  render(<VideoTileMedia asset={video()} active={false} onRequestActive={vi.fn()} onReleaseActive={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByRole("img", { name: "clip.webm" })).toHaveAttribute("decoding", "async");
});

it("maps pointer position to a scrub frame and delays video seeking", () => {
  render(<VideoTileMedia asset={video()} active onRequestActive={vi.fn()} onReleaseActive={vi.fn()} onRetry={vi.fn()} />);
  const slider = screen.getByRole("slider", { name: "영상 탐색" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100, top: 0, right: 100, bottom: 6, height: 6, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(slider, { pointerId: 1, clientX: 50 });
  expect(screen.getByRole("img")).toHaveAttribute("src", expect.stringContaining("/scrub-frame/video-1/5"));
  const media = screen.getByLabelText("clip.webm 미리보기") as HTMLVideoElement;
  expect(media.currentTime).toBe(0);
  vi.advanceTimersByTime(120);
  expect(media.currentTime).toBe(5);
});

it("keeps active playback attached across StrictMode effect checks", () => {
  render(<StrictMode><VideoTileMedia asset={video()} active onRequestActive={vi.fn()} onReleaseActive={vi.fn()} onRetry={vi.fn()} /></StrictMode>);
  expect(screen.getByLabelText("clip.webm 미리보기")).toHaveAttribute("src", "http://lakomics.localhost/playback/video-1");
});

it("renders pending and failed states with a retry action", () => {
  const retry = vi.fn();
  const { rerender } = render(<VideoTileMedia asset={video("pending")} active={false} onRequestActive={vi.fn()} onReleaseActive={vi.fn()} onRetry={retry} />);
  expect(screen.getByText("미리보기 준비 중")).toBeInTheDocument();
  rerender(<VideoTileMedia asset={video("failed")} active={false} onRequestActive={vi.fn()} onReleaseActive={vi.fn()} onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(retry).toHaveBeenCalledOnce();
});

function video(state: "pending" | "processing" | "ready" | "failed" = "ready"): AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> } {
  return {
    id: "video-1", title: null, originalName: "clip.webm", byteSize: 10,
    width: 1280, height: 720, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: null,
    sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null,
    importSource: null, importBatchId: null, originalModifiedAt: null,
    media: { kind: "video" as const, durationMs: 10_000, preparationState: state, scrubFrameCount: 10 },
  };
}
