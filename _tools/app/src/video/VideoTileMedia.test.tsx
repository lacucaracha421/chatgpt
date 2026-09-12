import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { VideoTileMedia } from "./VideoTileMedia";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("uses prepared frames on hover and delays full playback until timeline interaction", () => {
  const request = vi.fn();
  const release = vi.fn();
  const { container, rerender } = render(<VideoTileMedia asset={video()} active={false} onRequestActive={request} onReleaseActive={release} onRetry={vi.fn()} />);
  fireEvent.pointerEnter(container.querySelector(".video-tile")!);
  vi.advanceTimersByTime(159);
  expect(request).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(request).toHaveBeenCalledOnce();

  rerender(<VideoTileMedia asset={video()} active onRequestActive={request} onReleaseActive={release} onRetry={vi.fn()} />);
  expect(container.querySelector("video")).toBeNull();
  expect(screen.getByRole("img", { name: "clip.webm" })).toHaveAttribute("src", expect.stringContaining("/scrub-frame/video-1/1"));
  act(() => vi.advanceTimersByTime(720));
  expect(screen.getByRole("img", { name: "clip.webm" })).toHaveAttribute("src", expect.stringContaining("/scrub-frame/video-1/3"));

  const slider = container.querySelector(".video-tile__scrub") as HTMLDivElement;
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100, top: 0, right: 100, bottom: 6, height: 6, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(slider, { pointerId: 1, clientX: 50 });
  const media = container.querySelector("video") as HTMLVideoElement;
  expect(media.muted).toBe(true);
  expect(media.play).toHaveBeenCalledOnce();
  fireEvent.pointerLeave(container.querySelector(".video-tile")!);
  expect(release).toHaveBeenCalledOnce();
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

it("scrub only follows the pointer while the handle is held", () => {
  const request = vi.fn();
  render(<VideoTileMedia asset={video()} active={false} onRequestActive={request} onReleaseActive={vi.fn()} onRetry={vi.fn()} />);
  const slider = screen.getByRole("slider", { name: "영상 탐색" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100, top: 0, right: 100, bottom: 6, height: 6, x: 0, y: 0, toJSON: () => ({}) });

  // hover move만으로는 프리뷰 프레임을 바꾸지 않는다.
  fireEvent.pointerMove(slider, { pointerId: 1, clientX: 80 });
  expect(screen.getByRole("img", { name: "clip.webm" })).toHaveAttribute("src", "http://lakomics.localhost/thumbnail/video-1");

  // 잡은 뒤에는 드래그를 따라간다.
  fireEvent.pointerDown(slider, { pointerId: 1, clientX: 80 });
  expect(request).toHaveBeenCalled();
  fireEvent.pointerMove(slider, { pointerId: 1, clientX: 20 });
  expect(screen.getByRole("img", { name: "clip.webm" })).toHaveAttribute("src", expect.stringContaining("/scrub-frame/video-1/2"));
  expect(slider).toHaveAttribute("data-scrubbing");

  // 놓으면 드래그가 끝나고 이후 move는 무시된다.
  fireEvent.pointerUp(slider, { pointerId: 1, clientX: 20 });
  expect(slider).not.toHaveAttribute("data-scrubbing");
  fireEvent.pointerMove(slider, { pointerId: 1, clientX: 60 });
  expect(screen.getByRole("img", { name: "clip.webm" })).toHaveAttribute("src", expect.stringContaining("/scrub-frame/video-1/2"));
});

it("reflects playback position in the scrub control while playing", () => {
  const { container } = render(<VideoTileMedia asset={video()} active onRequestActive={vi.fn()} onReleaseActive={vi.fn()} onRetry={vi.fn()} />);
  const slider = container.querySelector(".video-tile__scrub") as HTMLDivElement;
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  const media = container.querySelector("video") as HTMLVideoElement;
  Object.defineProperty(media, "currentTime", { value: 2.5, writable: true, configurable: true });
  fireEvent.seeked(media);
  fireEvent(media, new Event("timeupdate"));
  expect(slider).toHaveAttribute("aria-valuenow", "2500");
  expect(slider.querySelector(".video-tile__scrub-fill")).toHaveAttribute("style", "width: 25%;");
});

it("does not attach the original video merely because a tile is active", () => {
  const { container } = render(<VideoTileMedia asset={video()} active onRequestActive={vi.fn()} onReleaseActive={vi.fn()} onRetry={vi.fn()} />);
  expect(container.querySelector("video")).toBeNull();
  expect(screen.getByRole("img", { name: "clip.webm" })).toHaveAttribute("src", expect.stringContaining("/scrub-frame/video-1/1"));
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

it("seeks the scrub slider by keyboard in five-second steps and clamps endpoints", () => {
  const request = vi.fn();
  const { container } = render(<VideoTileMedia asset={video()} active onRequestActive={request} onReleaseActive={vi.fn()} onRetry={vi.fn()} />);
  const slider = container.querySelector(".video-tile__scrub") as HTMLDivElement;

  expect(slider).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  const media = container.querySelector("video") as HTMLVideoElement;
  expect(slider).toHaveAttribute("aria-valuenow", "5000");
  act(() => vi.advanceTimersByTime(120));
  expect(media.currentTime).toBe(5);

  fireEvent.keyDown(slider, { key: "End" });
  expect(slider).toHaveAttribute("aria-valuenow", "10000");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(slider).toHaveAttribute("aria-valuenow", "10000");
  fireEvent.keyDown(slider, { key: "Home" });
  fireEvent.keyDown(slider, { key: "ArrowLeft" });
  expect(slider).toHaveAttribute("aria-valuenow", "0");
  expect(request).toHaveBeenCalled();
});
