import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterLaunchSettled, LAUNCH_CAP_MS, LAUNCH_COVER_ID, LAUNCH_IMAGE_CAP_MS, LaunchSplash, resetLaunchSplashForTests, useLaunchReady } from "./LaunchSplash";

const splash = () => document.querySelector<HTMLElement>(".launch-splash");
const start = () => 0;

function Screen({ ready, image = false }: { ready: boolean; image?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useLaunchReady(ready, host);
  return <div ref={host} data-testid="screen">{image && <img src="https://img.example/cover.jpg" alt="표지" />}</div>;
}

function staticCover() {
  const cover = document.createElement("div");
  cover.id = LAUNCH_COVER_ID;
  cover.className = "launch-splash";
  document.body.prepend(cover);
  return cover;
}

function reduceMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetLaunchSplashForTests();
  reduceMotion(false);
});
afterEach(() => {
  cleanup();
  document.getElementById(LAUNCH_COVER_ID)?.remove();
  vi.useRealTimers();
});

describe("LaunchSplash", () => {
  it('defers maintenance through readiness, image settling and the cover fade', () => {
    const view = render(<><Screen ready={false} /><LaunchSplash elapsed={start} /></>);
    const task = vi.fn();
    const cancel = afterLaunchSettled(task);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(task).not.toHaveBeenCalled();
    view.rerender(<><Screen ready /><LaunchSplash elapsed={start} /></>);
    act(() => { vi.advanceTimersByTime(120); });
    expect(splash()?.dataset.state).toBe('leaving');
    act(() => { vi.advanceTimersByTime(240); });
    expect(splash()).toBeNull();
    expect(task).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(task).toHaveBeenCalledOnce();
    cancel();
  });

  it('cancels maintenance when its workspace leaves before the idle window', () => {
    const task = vi.fn();
    const cancel = afterLaunchSettled(task);
    cancel();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(task).not.toHaveBeenCalled();
  });
  it("takes over the static index.html cover at mount and stays while the first screen is loading", () => {
    const cover = staticCover();
    render(<><Screen ready={false} /><LaunchSplash elapsed={start} /></>);
    expect(cover.isConnected).toBe(false);
    expect(screen.getByRole("status", { name: "Lakomics 여는 중" })).toBe(splash());
    act(() => { vi.advanceTimersByTime(LAUNCH_CAP_MS - 1); });
    expect(splash()?.dataset.state).toBeUndefined();
  });

  it("fades out once after the first screen is ready, then leaves the DOM", () => {
    const view = render(<><Screen ready={false} /><LaunchSplash elapsed={start} /></>);
    view.rerender(<><Screen ready /><LaunchSplash elapsed={start} /></>);
    act(() => { vi.advanceTimersByTime(200); });
    expect(splash()?.dataset.state).toBe("leaving");
    act(() => { vi.advanceTimersByTime(300); });
    expect(splash()).toBeNull();
  });

  it("reveals whatever is there at the cap, counted from the page start", () => {
    render(<><Screen ready={false} /><LaunchSplash elapsed={() => LAUNCH_CAP_MS - 500} /></>);
    act(() => { vi.advanceTimersByTime(499); });
    expect(splash()?.dataset.state).toBeUndefined();
    act(() => { vi.advanceTimersByTime(1); });
    expect(splash()?.dataset.state).toBe("leaving");
  });

  it("never comes back when the screen loads again later", () => {
    const view = render(<><Screen ready /><LaunchSplash elapsed={start} /></>);
    act(() => { vi.advanceTimersByTime(200); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(splash()).toBeNull();
    view.rerender(<><Screen key="again" ready={false} /><LaunchSplash elapsed={start} /></>);
    view.rerender(<><Screen key="again" ready /><LaunchSplash elapsed={start} /></>);
    act(() => { vi.advanceTimersByTime(LAUNCH_CAP_MS); });
    expect(splash()).toBeNull();
  });

  it("snaps away under reduced motion", () => {
    reduceMotion(true);
    const view = render(<><Screen ready={false} /><LaunchSplash elapsed={start} /></>);
    view.rerender(<><Screen ready /><LaunchSplash elapsed={start} /></>);
    act(() => { vi.advanceTimersByTime(130); });
    act(() => { vi.advanceTimersByTime(0); });
    expect(splash()).toBeNull();
  });

  it("continues the static cover's progress-hint timing instead of restarting it", () => {
    render(<LaunchSplash elapsed={() => 1200} />);
    expect(splash()?.style.getPropertyValue("--launch-hint-delay")).toBe("1800ms");
  });

  it("waits for the first screen's on-screen images, bounded by the image cap", () => {
    const rect = { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 300, width: 200, height: 300, toJSON: () => ({}) } as DOMRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    const decode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => new Promise<void>(() => undefined) });
    try {
      const view = render(<><Screen ready={false} image /><LaunchSplash elapsed={start} /></>);
      view.rerender(<><Screen ready image /><LaunchSplash elapsed={start} /></>);
      act(() => { vi.advanceTimersByTime(LAUNCH_IMAGE_CAP_MS - 100); });
      expect(splash()?.dataset.state).toBeUndefined();
      act(() => { vi.advanceTimersByTime(300); });
      expect(splash()?.dataset.state).toBe("leaving");
    } finally {
      rectSpy.mockRestore();
      if (decode) Object.defineProperty(HTMLImageElement.prototype, "decode", decode);
      else delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    }
  });
});
