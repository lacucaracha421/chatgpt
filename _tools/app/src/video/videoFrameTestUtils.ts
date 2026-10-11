import { act } from "@testing-library/react";
import { vi } from "vitest";

export function mockVideoFrames() {
  if (!HTMLVideoElement.prototype.requestVideoFrameCallback) {
    Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { configurable: true, writable: true, value: () => 0 });
    Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", { configurable: true, writable: true, value: () => undefined });
  }
  const callbacks = new Map<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>();
  let id = 0;
  vi.spyOn(HTMLVideoElement.prototype, "requestVideoFrameCallback").mockImplementation(function (this: HTMLVideoElement, callback) {
    const pending = callbacks.get(this) ?? new Map();
    callbacks.set(this, pending);
    pending.set(++id, callback);
    return id;
  });
  vi.spyOn(HTMLVideoElement.prototype, "cancelVideoFrameCallback").mockImplementation(function (this: HTMLVideoElement, handle) {
    callbacks.get(this)?.delete(handle);
  });
  return (video: HTMLVideoElement, mediaTime = video.currentTime, metadata: Partial<VideoFrameCallbackMetadata> = {}) => {
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
    const pending = callbacks.get(video);
    const frame = [...(pending?.values() ?? [])];
    pending?.clear();
    act(() => frame.forEach(callback => callback(performance.now(), { ...metadata, mediaTime } as VideoFrameCallbackMetadata)));
  };
}
