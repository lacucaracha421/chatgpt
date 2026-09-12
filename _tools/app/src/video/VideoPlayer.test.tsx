import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { AssetSummary } from "../library/types";
import { VideoPlayer } from "./VideoPlayer";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VideoPlayer", () => {
  it("uses the playback stream and reflects native time events", () => {
    render(<VideoPlayer asset={videoAsset()} />);
    const video = screen.getByLabelText("sample.webm 영상");
    expect(video).toHaveAttribute("src", "http://lakomics.localhost/playback/video-1");

    setMediaNumber(video, "duration", 90);
    setMediaNumber(video, "currentTime", 5);
    fireEvent.durationChange(video);
    fireEvent.timeUpdate(video);

    expect(screen.getByText("0:05 / 1:30")).toBeInTheDocument();
  });

  it("keeps its source attached across StrictMode effect checks", () => {
    render(<StrictMode><VideoPlayer asset={videoAsset()} /></StrictMode>);
    expect(screen.getByLabelText("sample.webm 영상")).toHaveAttribute("src", "http://lakomics.localhost/playback/video-1");
  });

  it("keeps pointer clicks from focusing the native video surface", () => {
    render(<VideoPlayer asset={videoAsset()} />);
    const video = screen.getByLabelText("sample.webm 영상");

    expect(video).toHaveAttribute("tabindex", "-1");
    expect(fireEvent.pointerDown(video)).toBe(false);
    fireEvent.click(video);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  });

  it("toggles playback with Space unless a control owns focus", () => {
    render(<VideoPlayer asset={videoAsset()} />);
    const player = screen.getByTestId("video-player");
    fireEvent.keyDown(player, { key: " ", code: "Space" });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();

    fireEvent.keyDown(screen.getByRole("button", { name: "재생" }), { key: " ", code: "Space" });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  });

  it("seeks with the timeline and shows the matching scrub frame", () => {
    render(<VideoPlayer asset={videoAsset()} />);
    const video = screen.getByLabelText("sample.webm 영상");
    const timeline = screen.getByRole("slider", { name: "재생 위치" });
    setMediaNumber(video, "duration", 100);
    fireEvent.durationChange(video);

    Object.defineProperty(timeline, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) }) });
    fireEvent.pointerMove(timeline, { clientX: 50 });
    expect(screen.getByRole("img", { name: "0:50 미리보기" })).toHaveAttribute("src", "http://lakomics.localhost/scrub-frame/video-1/5");

    fireEvent.change(timeline, { target: { value: "25" } });
    expect(video).toHaveProperty("currentTime", 25);
  });

  it("lets the timeline consume the available control width", () => {
    render(<VideoPlayer asset={videoAsset()} />);

    expect(screen.getByRole("slider", { name: "재생 위치" })).toHaveClass("video-player__timeline");
  });

  it("hides idle controls while playing and keeps them visible while paused", () => {
    vi.useFakeTimers();
    render(<VideoPlayer asset={videoAsset()} />);
    const video = screen.getByLabelText("sample.webm 영상");
    const player = screen.getByTestId("video-player");

    fireEvent.play(video);
    act(() => vi.advanceTimersByTime(1_799));
    expect(player).toHaveAttribute("data-controls-visible", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(player).toHaveAttribute("data-controls-visible", "false");

    fireEvent.pause(video);
    expect(player).toHaveAttribute("data-controls-visible", "true");
  });

  it("shows controls on pointer activity and defers hiding while scrubbing or focused", () => {
    vi.useFakeTimers();
    render(<VideoPlayer asset={videoAsset()} />);
    const video = screen.getByLabelText("sample.webm 영상");
    const player = screen.getByTestId("video-player");
    const timeline = screen.getByRole("slider", { name: "재생 위치" });
    const play = screen.getByRole("button", { name: "재생" });

    fireEvent.play(video);
    act(() => vi.advanceTimersByTime(1_800));
    expect(player).toHaveAttribute("data-controls-visible", "false");

    fireEvent.pointerMove(player);
    expect(player).toHaveAttribute("data-controls-visible", "true");
    fireEvent.pointerDown(timeline);
    act(() => vi.advanceTimersByTime(2_000));
    expect(player).toHaveAttribute("data-controls-visible", "true");
    fireEvent.pointerUp(timeline);
    act(() => vi.advanceTimersByTime(1_800));
    expect(player).toHaveAttribute("data-controls-visible", "false");

    fireEvent.pointerMove(player);
    fireEvent.focus(play);
    act(() => vi.advanceTimersByTime(2_000));
    expect(player).toHaveAttribute("data-controls-visible", "true");
    fireEvent.blur(play, { relatedTarget: video });
    act(() => vi.advanceTimersByTime(1_800));
    expect(player).toHaveAttribute("data-controls-visible", "false");
  });

  it("cleans up the idle timer when unmounted", () => {
    vi.useFakeTimers();
    const { unmount } = render(<VideoPlayer asset={videoAsset()} />);
    fireEvent.play(screen.getByLabelText("sample.webm 영상"));
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("synchronizes mute and volume with media events", () => {
    render(<VideoPlayer asset={videoAsset()} />);
    const video = screen.getByLabelText("sample.webm 영상");
    fireEvent.click(screen.getByRole("button", { name: "음소거" }));
    expect(video).toHaveProperty("muted", true);

    fireEvent.change(screen.getByRole("slider", { name: "음량" }), { target: { value: "0.35" } });
    expect(video).toHaveProperty("volume", 0.35);
    expect(video).toHaveProperty("muted", false);
  });

  it("enters and exits fullscreen through the platform API", () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });

    render(<VideoPlayer asset={videoAsset()} />);
    const player = screen.getByTestId("video-player");
    fireEvent.click(screen.getByRole("button", { name: "전체 화면" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();

    fullscreenElement = player;
    fireEvent(document, new Event("fullscreenchange"));
    fireEvent.click(screen.getByRole("button", { name: "전체 화면 종료" }));
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });
});

function videoAsset(durationMs = 100_000): AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> } {
  return { id: "video-1", title: null, originalName: "sample.webm", byteSize: 1, width: 1920, height: 1080, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "video", durationMs, preparationState: "ready", scrubFrameCount: 11 } };
}

function setMediaNumber(element: HTMLElement, property: "duration" | "currentTime", value: number) {
  Object.defineProperty(element, property, { configurable: true, writable: true, value });
}

describe("VideoPlayer zero-duration guard", () => {
  it("disables an unavailable timeline and restores it when valid metadata arrives", () => {
    render(<VideoPlayer asset={videoAsset(0)} />);
    const video = screen.getByLabelText("sample.webm 영상");
    const timeline = screen.getByRole("slider", { name: "재생 위치" });

    setMediaNumber(video, "duration", 0);
    fireEvent.durationChange(video);
    expect(timeline).toBeDisabled();
    expect(screen.getByText("0:00 / 0:00")).toBeInTheDocument();

    setMediaNumber(video, "duration", 30);
    fireEvent.durationChange(video);
    expect(timeline).not.toBeDisabled();
    expect(timeline).toHaveAttribute("max", "30");
  });
});
