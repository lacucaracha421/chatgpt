import { afterEach, expect, it, vi } from "vitest";
import { waitForVideoFrame } from "./waitForVideoFrame";
import { mockVideoFrames } from "./videoFrameTestUtils";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("ignores cancelled callbacks and pre-seek frames", () => {
  const present = mockVideoFrames();
  const video = document.createElement("video");
  const ready = vi.fn();
  const cancel = waitForVideoFrame(video, 0, ready);
  const request = vi.mocked(video.requestVideoFrameCallback);
  const stale = request.mock.calls[0][0];
  cancel();
  stale(0, { mediaTime: 0 } as VideoFrameCallbackMetadata);
  expect(ready).not.toHaveBeenCalled();
  video.currentTime = 5;
  waitForVideoFrame(video, 5, ready);
  present(video, 0);
  expect(ready).not.toHaveBeenCalled();
  present(video, 5);
  expect(ready).toHaveBeenCalledOnce();
});

it("falls back to decoded data and two paint opportunities, including a paused seek", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  Object.defineProperty(video, "requestVideoFrameCallback", { value: undefined });
  Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
  Object.defineProperty(video, "videoWidth", { value: 1920 });
  Object.defineProperty(video, "seeking", { configurable: true, value: true });
  const ready = vi.fn();
  const cancel = waitForVideoFrame(video, 5, ready);
  vi.advanceTimersByTime(2_000);
  expect(ready).not.toHaveBeenCalled();
  video.currentTime = 5;
  Object.defineProperty(video, "readyState", { value: 2 });
  Object.defineProperty(video, "seeking", { value: false });
  vi.advanceTimersToNextFrame();
  expect(ready).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expect(ready).toHaveBeenCalledOnce();
  cancel();
  expect(vi.getTimerCount()).toBe(0);
});

it("accepts a paused seek frame presented before seeked without waiting for another frame", () => {
  const present = mockVideoFrames();
  const video = document.createElement("video");
  video.currentTime = 5;
  Object.defineProperty(video, "seeking", { configurable: true, value: true });
  const ready = vi.fn();
  waitForVideoFrame(video, 5, ready);
  present(video);
  expect(ready).not.toHaveBeenCalled();
  Object.defineProperty(video, "seeking", { value: false });
  video.dispatchEvent(new Event("seeked"));
  expect(ready).toHaveBeenCalledOnce();
  expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
});

it("cancels fallback paints when another seek or unmount supersedes them", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  Object.defineProperty(video, "requestVideoFrameCallback", { value: undefined });
  const ready = vi.fn();
  waitForVideoFrame(video, 0, ready)();
  vi.advanceTimersByTime(2_000);
  expect(ready).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
