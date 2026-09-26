import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PhysicalCover } from "./PhysicalCover";
import { acquireCover, coverSourceUrl, type CoverRequest } from "./collectibleRuntime";
import type { Rank, Snapshot } from "./RenderCache";

const visibility = vi.hoisted(() => ({ notify: [] as Array<(near: boolean, visible: boolean) => void> }));
vi.mock("./coverVisibility", () => ({
  observeCover: (_element: Element, notify: (near: boolean, visible: boolean) => void) => { visibility.notify.push(notify); notify(true, true); return vi.fn(); },
  observeCoverSize: () => vi.fn(),
}));
vi.mock("./collectibleRuntime", async (original) => ({ ...await original<typeof import("./collectibleRuntime")>(), acquireCover: vi.fn(() => vi.fn()) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); visibility.notify.length = 0; });
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
  const image = screen.getByRole("img", { name: "Book" });
  const flat = coverSourceUrl({ src: "/cover/a", scope: "library", revision: "2" });
  expect(sources(container)).not.toContain(flat);
  expect(image).not.toHaveAttribute("src");
  expect(image.parentElement).toHaveAttribute("data-source", "pending");
  expect(image.parentElement).toHaveAttribute("data-ready", "false");
  expect(image).toHaveAttribute("crossorigin", "anonymous");
  act(() => pending[0].notify({ url: "blob:rendered", width: 256, height: 368 }));
  expect(image).toHaveAttribute("src", "blob:rendered");
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
  expect(sources(container)).toEqual(["blob:shell", null]);
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
  const image = screen.getByRole("img", { name: "Book" });
  expect(image).not.toHaveAttribute("src");
  act(() => pending[1].notify(null));
  expect(image).toHaveAttribute("src", "/b");
  expect(image.parentElement).toHaveAttribute("data-source", "fallback");
  fireEvent.error(image);
  expect(onError).toHaveBeenCalledOnce();
});

it("falls back to the source when a finished render cannot be displayed", () => {
  const pending = capture();
  render(<PhysicalCover kind="book" src="/a" alt="Book" />);
  act(() => pending[0].notify({ url: "blob:broken", width: 256, height: 368 }));
  const image = screen.getByRole("img", { name: "Book" });
  fireEvent.error(image);
  expect(image).toHaveAttribute("src", "/a");
  expect(image.parentElement).toHaveAttribute("data-source", "fallback");
});
