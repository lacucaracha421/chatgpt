import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PhysicalCover } from "./PhysicalCover";
import { acquireCover, coverSourceUrl, type CoverRequest } from "./collectibleRuntime";
import { RenderCache, THUMBNAIL_LIMIT, type Rank, type Snapshot } from "./RenderCache";

const visibility = vi.hoisted(() => ({ notify: [] as Array<(near: boolean, visible: boolean) => void>, sizes: [] as Array<(width: number) => void> }));
vi.mock("./coverVisibility", () => ({
  observeCover: (_element: Element, notify: (near: boolean, visible: boolean) => void) => { visibility.notify.push(notify); notify(true, true); return vi.fn(); },
  observeCoverSize: (_element: Element, notify: (width: number) => void) => { visibility.sizes.push(notify); return vi.fn(); },
}));
vi.mock("./collectibleRuntime", async (original) => ({ ...await original<typeof import("./collectibleRuntime")>(), acquireCover: vi.fn(() => vi.fn()) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); visibility.notify.length = 0; visibility.sizes.length = 0; vi.restoreAllMocks(); });
type Pending = { request: CoverRequest; notify: (value: Snapshot) => void; rank?: Rank };
function capture() {
  const pending: Pending[] = [];
  vi.mocked(acquireCover).mockImplementation((request, notify, rank) => { pending.push({ request, notify, rank }); return vi.fn(); });
  return pending;
}
const sources = (container: HTMLElement) => [...container.querySelectorAll("img")].map(image => image.getAttribute("src"));

it("renders a neutral game shell only when no source is available", () => {
  const pending = capture();
  const { rerender } = render(<PhysicalCover kind="game" src={null} alt="Game" />);
  act(() => pending[0].notify({ url: "blob:shell", width: 256, height: 368 }));
  const image = screen.getByRole("img", { name: "Game" });
  expect(image).toHaveAttribute("src", "blob:shell");
  expect(image.parentElement).toHaveAttribute("data-source", "rendered");
  vi.mocked(acquireCover).mockClear();
  rerender(<PhysicalCover kind="game" src="/game" alt="Game" />);
  expect(acquireCover).toHaveBeenCalledOnce();
  expect(acquireCover).toHaveBeenCalledWith(expect.objectContaining({ src: "/game" }), expect.any(Function), expect.any(Function));
});

it("never shows the flat source while a render is pending, then fades the render in", () => {
  const pending = capture();
  const { container } = render(<PhysicalCover kind="book" src="/cover/a" alt="Book" scope="library" revision="2" />);
  const cover = container.querySelector(".physical-cover")!;
  const flat = coverSourceUrl({ src: "/cover/a", scope: "library", revision: "2" });
  expect(sources(container)).not.toContain(flat);
  // No image element without a source: source-less images cost WebKitGTK a frame each.
  expect(screen.queryByRole("img", { name: "Book" })).toBeNull();
  expect(cover).toHaveAttribute("data-source", "pending");
  expect(cover).toHaveAttribute("data-ready", "false");
  act(() => pending[0].notify({ url: "blob:rendered", width: 256, height: 368 }));
  const image = screen.getByRole("img", { name: "Book" });
  expect(image).toHaveAttribute("src", "blob:rendered");
  expect(image).toHaveAttribute("crossorigin", "anonymous");
  expect(image.parentElement).not.toHaveAttribute("data-instant");
  expect(image.parentElement).toHaveAttribute("data-ready", "false");
  fireEvent.load(image);
  expect(image.parentElement).toHaveAttribute("data-ready", "true");
});

it("keeps the neutral case under a pending game cover instead of its flat artwork", () => {
  const pending = capture();
  const { container } = render(<PhysicalCover kind="game" src="/game" alt="Game" />);
  const shell = pending.find(job => job.request.scope === "neutral-shell")!;
  act(() => shell.notify({ url: "blob:shell", width: 256, height: 362 }));
  expect(sources(container)).toEqual(["blob:shell"]);
  expect(container.querySelector(".physical-cover")).toHaveAttribute("data-shell", "true");
  act(() => pending.find(job => job.request.src === "/game")!.notify({ url: "blob:case", width: 256, height: 362 }));
  expect(screen.getByRole("img", { name: "Game" })).toHaveAttribute("src", "blob:case");
  expect(sources(container)).not.toContain("/game");
});

it("shows a cached render without a fade and ranks on-screen covers first", () => {
  vi.mocked(acquireCover).mockImplementation((_request, notify) => { notify({ url: "blob:cached", width: 256, height: 368 }); return vi.fn(); });
  render(<PhysicalCover kind="book" src="/a" alt="Book" />);
  expect(screen.getByRole("img", { name: "Book" }).parentElement).toHaveAttribute("data-instant", "true");
  cleanup();
  const pending = capture();
  render(<PhysicalCover kind="book" src="/b" alt="Book" />);
  const rank = pending[0].rank!;
  expect(rank()).toBe(0);
  act(() => visibility.notify[visibility.notify.length - 1](true, false));
  expect(rank()).toBe(1);
});

it("falls back to the flat source only when rendering fails, and rejects late obsolete covers", () => {
  const pending = capture();
  const onError = vi.fn();
  const { rerender } = render(<PhysicalCover kind="book" src="/a" alt="Book" onError={onError} />);
  rerender(<PhysicalCover kind="book" src="/b" alt="Book" onError={onError} />);
  act(() => pending[0].notify({ url: "blob:obsolete", width: 256, height: 368 }));
  expect(screen.queryByRole("img", { name: "Book" })).toBeNull();
  act(() => pending[1].notify(null));
  const image = screen.getByRole("img", { name: "Book" });
  expect(image).toHaveAttribute("src", "/b");
  expect(screen.getByRole("img", { name: "Book" }).parentElement).toHaveAttribute("data-source", "fallback");
  fireEvent.error(image);
  expect(onError).toHaveBeenCalledOnce();
});

it("falls back to the source when a finished render cannot be displayed", () => {
  const pending = capture();
  render(<PhysicalCover kind="book" src="/a" alt="Book" />);
  act(() => pending[0].notify({ url: "blob:broken", width: 256, height: 368 }));
  const image = screen.getByRole("img", { name: "Book" });
  fireEvent.error(image);
  expect(screen.getByRole("img", { name: "Book" })).toHaveAttribute("src", "/a");
  expect(screen.getByRole("img", { name: "Book" }).parentElement).toHaveAttribute("data-source", "fallback");
});

// A near notification can arrive before ResizeObserver's first delivery in WebKit.
it("requests the measured game bucket on each mount, without a transient 256px request", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 180, height: 255 } as DOMRect);
  const pending = capture();
  for (let visit = 0; visit < 2; visit++) {
    const view = render(<PhysicalCover kind="game" src="/game" alt="Game" />);
    act(() => visibility.sizes[visibility.sizes.length - 1](180));
    view.unmount();
  }
  expect(pending.filter(job => job.request.src === "/game").map(job => job.request.pixels)).toEqual([192, 192]);
});

it("ignores a hidden zero width instead of requesting another game bucket", () => {
  const pending = capture();
  render(<PhysicalCover kind="game" src="/game" alt="Game" />);
  act(() => visibility.sizes[0](300));
  const before = pending.length;
  act(() => visibility.sizes[0](0));
  expect(pending).toHaveLength(before);
});

it("keeps the loaded case and its lease until a replacement image loads", () => {
  const pending = capture(), releases: ReturnType<typeof vi.fn>[] = [];
  vi.mocked(acquireCover).mockImplementation((request, notify, rank) => {
    pending.push({ request, notify, rank });
    const release = vi.fn(); releases.push(release); return release;
  });
  const view = render(<PhysicalCover kind="game" src="/a" alt="Game" />);
  const first = pending.findIndex(job => job.request.src === "/a");
  act(() => pending[first].notify({ url: "blob:a", width: 256, height: 362 }));
  fireEvent.load(screen.getByRole("img", { name: "Game" }));
  view.rerender(<PhysicalCover kind="game" src="/b" alt="Game" />);
  expect(sources(view.container)).toContain("blob:a");
  expect(releases[first]).not.toHaveBeenCalled();
  act(() => pending.find(job => job.request.src === "/b")!.notify({ url: "blob:b", width: 256, height: 362 }));
  expect(sources(view.container)).toContain("blob:a");
  fireEvent.load(screen.getByRole("img", { name: "Game" }));
  expect(sources(view.container)).not.toContain("blob:a");
  expect(releases[first]).toHaveBeenCalledOnce();
  view.unmount();
  expect(releases.every(release => release.mock.calls.length === 1)).toBe(true);
});

it("bakes 181 games once across measured remounts and stops at idle", async () => {
  vi.useFakeTimers();
  let blobId = 0;
  const create = vi.fn(() => `blob:count-${++blobId}`), revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL:create, revokeObjectURL:revoke });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width:180, height:255 } as DOMRect);
  const cache = new RenderCache(THUMBNAIL_LIMIT);
  const produce = vi.fn(async () => ({ blob:new Blob([new Uint8Array(100_000)]), width:192, height:272 }));
  vi.mocked(acquireCover).mockImplementation((request, notify, rank) => cache.acquire(JSON.stringify(request), produce, notify, rank));
  try {
    for (let visit = 0; visit < 2; visit++) {
      for (let start = 0; start < 181; start += 36) {
        const view = render(<>{Array.from({ length:Math.min(36,181-start) }, (_, index) =>
          <PhysicalCover key={start+index} kind="game" src={`/game/${start+index}`} alt="Game" scope="library" revision="1" />)}</>);
        act(() => visibility.sizes.slice(-Math.min(36,181-start)).forEach(notify => notify(180)));
        await act(async () => { await vi.runAllTimersAsync(); });
        view.unmount();
      }
      // One neutral case shared by every tile, plus 181 artwork bakes.
      expect(produce).toHaveBeenCalledTimes(182);
    }
    await vi.advanceTimersByTimeAsync(70_000);
    expect(produce).toHaveBeenCalledTimes(182);
    expect(cache.stats()).toMatchObject({ completed:182, evictions:0, active:0, pending:0 });
  } finally { cache.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
