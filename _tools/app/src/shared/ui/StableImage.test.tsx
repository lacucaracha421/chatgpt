import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StableImage } from "./StableImage";

afterEach(cleanup);

it("allows an opted-in first appearance on load but holds that same image through a slow refresh", async () => {
  const { container, rerender } = render(<StableImage src="/first" alt="Cover" decodeFirst={false} decoding="async" />);
  const first = screen.getByRole<HTMLImageElement>("img");
  first.decode = vi.fn(() => new Promise<void>(() => {}));
  fireEvent.load(first);
  expect(first.decode).not.toHaveBeenCalled();
  expect(first.style.visibility).toBe("");
  rerender(<StableImage src="/next" alt="Cover" decodeFirst={false} decoding="async" />);
  const next = container.querySelector<HTMLImageElement>('img[src="/next"]')!;
  let finish!: () => void;
  next.decode = () => new Promise<void>(resolve => { finish = resolve; });
  fireEvent.load(next);
  expect(screen.getByRole("img")).toBe(first);
  expect(next.style.visibility).toBe("hidden");
  await act(async () => finish());
  expect(screen.getByRole("img")).toBe(next);
});

it("returns to the already loaded A image after A to B to A without another load event", async () => {
  const { container, rerender } = render(<StableImage src="/a" alt="A" />);
  fireEvent.load(screen.getByRole("img"));
  rerender(<StableImage src="/b" alt="B" />);
  fireEvent.load(container.querySelector('img[src="/b"]')!);
  expect(screen.getByRole("img")).toHaveAttribute("src", "/b");
  rerender(<StableImage src="/a" alt="A" />);
  expect(screen.getByRole("img")).toHaveAttribute("src", "/a");
});

it("does not promote B when its decode completes after returning to A", async () => {
  const { container, rerender } = render(<StableImage src="/a" alt="A" />);
  fireEvent.load(screen.getByRole("img"));
  rerender(<StableImage src="/b" alt="B" />);
  let finish!: () => void;
  const b = container.querySelector<HTMLImageElement>('img[src="/b"]')!;
  b.decode = () => new Promise<void>(resolve => { finish = resolve; });
  fireEvent.load(b);
  rerender(<StableImage src="/a" alt="A" />);
  await act(async () => finish());
  expect(screen.getByRole("img")).toHaveAttribute("src", "/a");
});

it("prefetches only after the current decode and promotes that same DOM image without another load", async () => {
  const { container, rerender } = render(<StableImage src="/a" alt="A" prefetchSrc="/b" />);
  const a = screen.getByRole("img");
  let finishA!: () => void;
  (a as HTMLImageElement).decode = () => new Promise<void>(resolve => { finishA = resolve; });
  fireEvent.load(a);
  expect(container.querySelector('img[src="/b"]')).toBeNull();
  await act(async () => finishA());
  const b = container.querySelector<HTMLImageElement>('img[src="/b"]')!;
  let finishB!: () => void;
  b.decode = () => new Promise<void>(resolve => { finishB = resolve; });
  fireEvent.load(b);
  expect(screen.getByRole("img")).toBe(a);
  await act(async () => finishB());
  expect(screen.getByRole("img")).toBe(a);
  rerender(<StableImage src="/b" alt="B" prefetchSrc="/c" />);
  expect(screen.getByRole("img", { name: "B" })).toBe(b);
  expect(container.querySelectorAll("img")).toHaveLength(2);
  expect(container.querySelector('img[src="/c"]')).not.toBeNull();
});

it("keeps the painted image during a slow next decode and ignores a superseded prefetch", async () => {
  const { container, rerender } = render(<StableImage src="/a" alt="A" prefetchSrc="/b" />);
  fireEvent.load(screen.getByRole("img"));
  const a = screen.getByRole("img");
  const b = container.querySelector<HTMLImageElement>('img[src="/b"]')!;
  let finish!: () => void;
  b.decode = () => new Promise<void>(resolve => { finish = resolve; });
  fireEvent.load(b);
  rerender(<StableImage src="/c" alt="C" prefetchSrc="/d" />);
  await act(async () => finish());
  expect(screen.getByRole("img")).toBe(a);
  fireEvent.load(container.querySelector('img[src="/c"]')!);
  // The reused slot still has the mocked asynchronous decode.
  await act(async () => finish());
  expect(screen.getByRole("img", { name: "C" })).toHaveAttribute("src", "/c");
});

it("reports a speculative failure only when that source is requested", () => {
  let errors = 0;
  const onPreloadError = () => { errors++; };
  const { container, rerender } = render(<StableImage src="/a" alt="A" prefetchSrc="/b" onPreloadError={onPreloadError} />);
  fireEvent.load(screen.getByRole("img"));
  fireEvent.error(container.querySelector('img[src="/b"]')!);
  expect(errors).toBe(0);
  expect(screen.getByRole("img")).toHaveAttribute("src", "/a");
  rerender(<StableImage src="/b" alt="B" onPreloadError={onPreloadError} />);
  expect(errors).toBeGreaterThan(0);
});
