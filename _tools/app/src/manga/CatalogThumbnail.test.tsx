import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogThumbnail } from "./CatalogThumbnail";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reports readiness only after the mounted image decodes", async () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  const settled = vi.fn();
  render(<CatalogThumbnail src="https://example.com/a.jpg" title="작품" pageCount={24} onSettled={settled} />);
  const image = screen.getByRole("img");
  let finish!: () => void;
  Object.defineProperty(image, "decode", { value: () => new Promise<void>(resolve => { finish = resolve; }) });
  fireEvent.load(image);
  expect(settled).not.toHaveBeenCalledWith(true);
  await act(async () => finish());
  expect(settled).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("img")).toBe(image);
});

it("commits the normal fallback before reporting a decode failure as settled", async () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  const settled = vi.fn((ready: boolean) => {
    if (ready) expect(screen.getByText("24페이지")).toBeInTheDocument();
  });
  render(<CatalogThumbnail src="https://example.com/a.jpg" title="작품" pageCount={24} onSettled={settled} />);
  Object.defineProperty(screen.getByRole("img"), "decode", { value: () => Promise.reject(new Error("decode failed")) });
  await act(async () => fireEvent.load(screen.getByRole("img")));
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(settled).toHaveBeenLastCalledWith(true);
});

it("settles missing covers and revokes readiness when their source changes", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  const settled = vi.fn();
  const view = render(<CatalogThumbnail src={null} title="작품" pageCount={24} onSettled={settled} />);
  expect(settled).toHaveBeenLastCalledWith(true);
  view.rerender(<CatalogThumbnail src="https://example.com/new.jpg" title="작품" pageCount={24} onSettled={settled} />);
  expect(settled).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("img")).toBeInTheDocument();
});

it("requests a deferred cover only near its own scrollport and preserves its decoded image", async () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  let notify!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  const observe = vi.fn();
  const options = vi.fn();
  class Observer {
    constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit) { notify = callback; options(init); }
    observe = observe;
    disconnect = disconnect;
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const settled = vi.fn();
  render(<div className="online-catalog__content" data-testid="scrollport">
    <CatalogThumbnail src="https://example.com/a.jpg" title="작품" pageCount={24} deferUntilNear onSettled={settled} />
  </div>);
  const image = screen.getByRole("img");
  expect(image).not.toHaveAttribute("src");
  expect(options).toHaveBeenCalledWith({ root: screen.getByTestId("scrollport"), rootMargin: "120px" });
  expect(observe).toHaveBeenCalledWith(image);
  expect(settled).not.toHaveBeenCalledWith(true);
  const entry = (isIntersecting: boolean): IntersectionObserverEntry => ({
    target: image, isIntersecting, time: 0, intersectionRatio: isIntersecting ? 1 : 0,
    boundingClientRect: image.getBoundingClientRect(), intersectionRect: image.getBoundingClientRect(), rootBounds: null,
  });
  act(() => notify([entry(false)], {} as IntersectionObserver));
  expect(image).not.toHaveAttribute("src");
  act(() => notify([entry(true)], {} as IntersectionObserver));
  expect(image).toHaveAttribute("src", "https://example.com/a.jpg");
  expect(settled).not.toHaveBeenCalledWith(true);
  let finish!: () => void;
  Object.defineProperty(image, "decode", { value: () => new Promise<void>(resolve => { finish = resolve; }) });
  fireEvent.load(image);
  expect(settled).not.toHaveBeenCalledWith(true);
  await act(async () => finish());
  expect(settled).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("img")).toBe(image);
  expect(disconnect).toHaveBeenCalled();
});
