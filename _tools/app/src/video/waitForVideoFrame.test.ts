import { afterEach, expect, it, vi } from "vitest";
import { waitForVideoFrame } from "./waitForVideoFrame";
import { mockVideoFrames } from "./videoFrameTestUtils";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("keeps the still until a submitted frame has had a paint opportunity after its display time", () => {
  vi.useFakeTimers();
  mockVideoFrames();
  const video = document.createElement("video");
  const ready = vi.fn();
  waitForVideoFrame(video, 0, ready);
  const callback = vi.mocked(video.requestVideoFrameCallback).mock.calls[0][0];
  // Decode readiness is independent of the compositor's future display time.
  Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1920 } });
  callback(performance.now(), { mediaTime: 0, expectedDisplayTime: performance.now() + 16 } as VideoFrameCallbackMetadata);
  expect(ready).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expect(ready).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expect(ready).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a submitted frame's pending reveal when a newer seek supersedes it", () => {
  vi.useFakeTimers();
  mockVideoFrames();
  const video = document.createElement("video");
  const ready = vi.fn();
  const cancel = waitForVideoFrame(video, 0, ready);
  const callback = vi.mocked(video.requestVideoFrameCallback).mock.calls[0][0];
  Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1920 } });
  callback(performance.now(), { mediaTime: 0, expectedDisplayTime: performance.now() + 16 } as VideoFrameCallbackMetadata);
  cancel();
  vi.advanceTimersByTime(100);
  expect(ready).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("allows a paint after a later display time without requiring another paused video frame", () => {
  vi.useFakeTimers();
  const present = mockVideoFrames();
  const video = document.createElement("video");
  video.currentTime = 5;
  const ready = vi.fn();
  waitForVideoFrame(video, 5, ready);
  present(video, 5, { expectedDisplayTime: performance.now() + 64 });
  vi.advanceTimersByTime(64);
  expect(ready).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expect(ready).toHaveBeenCalledOnce();
});

it("rechecks the position after waiting for paint instead of revealing a superseded frame", () => {
  vi.useFakeTimers();
  const present = mockVideoFrames();
  const video = document.createElement("video");
  const ready = vi.fn();
  waitForVideoFrame(video, 0, ready);
  present(video, 0, { expectedDisplayTime: performance.now() + 16 });
  video.currentTime = 5;
  vi.advanceTimersByTime(32);
  expect(ready).not.toHaveBeenCalled();
  present(video, 5, { expectedDisplayTime: performance.now() + 16 });
  vi.advanceTimersByTime(32);
  expect(ready).toHaveBeenCalledOnce();
});

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
