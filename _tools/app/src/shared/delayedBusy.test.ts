import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelayedBusy } from "./delayedBusy";

describe("delayed busy timing", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it("never shows quick work", () => {
    const changed = vi.fn(), timing = createDelayedBusy(changed);
    timing.setBusy(true); vi.advanceTimersByTime(599); timing.setBusy(false); vi.runAllTimers();
    expect(changed).not.toHaveBeenCalled();
  });
  it("shows only after the delay and hides when long work finishes", () => {
    const changed = vi.fn(), timing = createDelayedBusy(changed);
    timing.setBusy(true); vi.advanceTimersByTime(599); expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(changed.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(1000); timing.setBusy(false); expect(changed.mock.calls).toEqual([[true], [false]]);
  });
  it("measures minimum visibility from appearance, not completion", () => {
    const changed = vi.fn(), timing = createDelayedBusy(changed);
    timing.setBusy(true); vi.advanceTimersByTime(650); timing.setBusy(false);
    vi.advanceTimersByTime(349); expect(changed.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(1); expect(changed.mock.calls).toEqual([[true], [false]]);
  });
  it("requires continuous busy time before first appearance", () => {
    const changed = vi.fn(), timing = createDelayedBusy(changed);
    timing.setBusy(true); vi.advanceTimersByTime(500); timing.setBusy(false);
    vi.advanceTimersByTime(10); timing.setBusy(true); vi.advanceTimersByTime(599);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(changed.mock.calls).toEqual([[true]]);
  });
  it("keeps a visible label through rapid toggles without restarting or flashing", () => {
    const changed = vi.fn(), timing = createDelayedBusy(changed);
    timing.setBusy(true); vi.advanceTimersByTime(650); timing.setBusy(false);
    vi.advanceTimersByTime(50); timing.setBusy(true); vi.advanceTimersByTime(400);
    expect(changed.mock.calls).toEqual([[true]]);
    timing.setBusy(false); expect(changed.mock.calls).toEqual([[true], [false]]);
    timing.setBusy(true); vi.advanceTimersByTime(100); timing.setBusy(false); vi.runAllTimers();
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });
  it("ignores duplicate notifications and supports custom timing", () => {
    const changed = vi.fn(), timing = createDelayedBusy(changed, { delay: 100, minVisible: 200 });
    timing.setBusy(true); vi.advanceTimersByTime(50); timing.setBusy(true); vi.advanceTimersByTime(50);
    timing.setBusy(false); vi.advanceTimersByTime(199); expect(changed.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(1); expect(changed.mock.calls).toEqual([[true], [false]]);
  });
  it("cancels pending callbacks on disposal", () => {
    const changed = vi.fn(), timing = createDelayedBusy(changed);
    timing.setBusy(true); timing.dispose(); vi.runAllTimers(); expect(changed).not.toHaveBeenCalled();
  });
});
