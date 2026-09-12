import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PhysicalCover } from "./PhysicalCover";
import { acquireCover, coverSourceUrl } from "./collectibleRuntime";
import type { Snapshot } from "./RenderCache";

vi.mock("./coverVisibility", () => ({
  observeCover: (_element: Element, notify: (visible: boolean) => void) => { notify(true); return vi.fn(); },
  observeCoverSize: () => vi.fn(),
}));
vi.mock("./collectibleRuntime", async (original) => ({ ...await original<typeof import("./collectibleRuntime")>(), acquireCover: vi.fn(() => vi.fn()) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("renders a neutral game shell only when no source is available", () => {
  let finish!: (value: Snapshot) => void;
  vi.mocked(acquireCover).mockImplementation((_request, notify) => { finish = notify; return vi.fn(); });
  const { rerender } = render(<PhysicalCover kind="game" src={null} alt="Game" />);
  act(() => finish({ url: "blob:shell", width: 256, height: 368 }));
  const image = screen.getByRole("img", { name: "Game" });
  expect(image).toHaveAttribute("src", "blob:shell");
  expect(image.parentElement).toHaveAttribute("data-source", "rendered");
  vi.mocked(acquireCover).mockClear();
  rerender(<PhysicalCover kind="game" src="/game" alt="Game" />);
  expect(image).toHaveAttribute("src", "/game");
  expect(acquireCover).toHaveBeenCalledOnce();
  expect(acquireCover).toHaveBeenCalledWith(expect.objectContaining({ src: "/game" }), expect.any(Function));
});

it("shows the scoped source while rendering and replaces it with the completed cover", () => {
  let finish!: (value: Snapshot) => void;
  vi.mocked(acquireCover).mockImplementation((_request, notify) => { finish = notify; return vi.fn(); });
  render(<PhysicalCover kind="book" src="/cover/a" alt="Book" scope="library" revision="2" />);
  const image = screen.getByRole("img", { name: "Book" });
  expect(image).toHaveAttribute("src", coverSourceUrl({ src: "/cover/a", scope: "library", revision: "2" }));
  expect(image).toHaveAttribute("crossorigin", "anonymous");
  act(() => finish({ url: "blob:rendered", width: 256, height: 368 }));
  expect(image).toHaveAttribute("src", "blob:rendered");
});

it("rejects a late cover from the previous source and keeps the current source on render failure", () => {
  const finishes: Array<(value: Snapshot) => void> = [];
  vi.mocked(acquireCover).mockImplementation((_request, notify) => { finishes.push(notify); return vi.fn(); });
  const onError = vi.fn();
  const { rerender } = render(<PhysicalCover kind="book" src="/a" alt="Book" onError={onError} />);
  rerender(<PhysicalCover kind="book" src="/b" alt="Book" onError={onError} />);
  act(() => finishes[0]({ url: "blob:obsolete", width: 256, height: 368 }));
  const image = screen.getByRole("img", { name: "Book" });
  expect(image).toHaveAttribute("src", "/b");
  act(() => finishes[1](null));
  expect(image).toHaveAttribute("src", "/b");
  fireEvent.error(image);
  expect(onError).toHaveBeenCalledOnce();
});
