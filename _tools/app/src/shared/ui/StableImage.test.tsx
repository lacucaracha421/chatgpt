import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StableImage } from "./StableImage";

afterEach(cleanup);

it("does not fade a first image whose load and decode finish before the first frame", async () => {
  render(<StableImage src="/immediate-cache-decode" alt="Cached" />);
  const image = screen.getByRole<HTMLImageElement>("img");
  image.decode = () => Promise.resolve();
  image.animate = vi.fn();
  fireEvent.load(image);
  await act(async () => undefined);
  expect(image.animate).not.toHaveBeenCalled();
  expect(image.style.opacity).toBe("");
});

it.each([false, true])("keeps a genuinely slow first decode's fade, respecting the tablet reduced-motion opt-in (%s)", async respectReducedMotion => {
  const media = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  try {
    render(<StableImage src="/slow" alt="Slow" respectReducedMotion={respectReducedMotion} />);
    const image = screen.getByRole<HTMLImageElement>("img");
    let finish!: () => void;
    image.decode = () => new Promise<void>(resolve => { finish = resolve; });
    image.animate = vi.fn(() => ({ cancel: vi.fn() } as unknown as Animation));
    fireEvent.load(image);
    expect(image.style.opacity).toBe("0");
    await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
    await act(async () => finish());
    expect(image.style.opacity).toBe("");
    expect(image.animate).toHaveBeenCalledTimes(respectReducedMotion ? 0 : 1);
  } finally {
    if (media) Object.defineProperty(window, "matchMedia", media);
    else Reflect.deleteProperty(window, "matchMedia");
  }
});

it("does not hold or fade a cached bitmap already complete when its DOM slot mounts", async () => {
  const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  const width = vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(100);
  try {
    render(<StableImage src="/cached" alt="Cached" />);
    const image = screen.getByRole<HTMLImageElement>("img");
    let finish!: () => void;
    image.decode = () => new Promise<void>(resolve => { finish = resolve; });
    image.animate = vi.fn();
    fireEvent.load(image);
    expect(image.style.opacity).toBe("");
    await act(async () => finish());
    expect(image.animate).not.toHaveBeenCalled();
    fireEvent.load(image);
    expect(image.style.opacity).toBe("");
  } finally { complete.mockRestore(); width.mockRestore(); }
});

it("fades a late first image for 150ms but swaps replacements only after decode without fading", async () => {
  const {container, rerender} = render(<StableImage src="/first" alt="Cover"/>);
  const first = screen.getByRole<HTMLImageElement>("img");
  const cancel = vi.fn(); first.animate = vi.fn(() => ({cancel} as unknown as Animation));
  await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
  fireEvent.load(first);
  expect(first.animate).toHaveBeenCalledWith([{opacity: 0}, {opacity: 1}], expect.objectContaining({duration: 150}));
  rerender(<StableImage src="/next" alt="Cover"/>);
  const next = container.querySelector<HTMLImageElement>('img[src="/next"]')!;
  next.animate = vi.fn(); let finish!: () => void;
  next.decode = () => new Promise<void>(resolve => { finish = resolve; });
  fireEvent.load(next);
  expect(screen.getByRole("img")).toBe(first);
  await act(async () => finish());
  expect(screen.getByRole("img")).toBe(next); expect(next.animate).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});

it("never leaves a held first bitmap invisible when its source changes during decode", async () => {
  const { container, rerender } = render(<StableImage src="/first" alt="Cover" loading="lazy" />);
  const first = screen.getByRole<HTMLImageElement>("img");
  let finish!: () => void;
  first.decode = () => new Promise<void>(resolve => { finish = resolve; });
  fireEvent.load(first);
  expect(first.style.opacity).toBe("0");
  rerender(<StableImage src="/next" alt="Cover" loading="lazy" />);
  await act(async () => finish());
  first.decode = () => Promise.resolve();
  // The stale hold is released: this element is still the painted image until /next decodes.
  expect(first.style.opacity).toBe("");
  expect(screen.getByRole("img")).toBe(first);
  const next = container.querySelector<HTMLImageElement>('img[src="/next"]')!;
  fireEvent.load(next);
  await act(async () => undefined);
  expect(screen.getByRole("img")).toBe(next);
  expect(next.style.opacity).toBe("");
  // The old slot is recycled for later sources and must not carry the hold either.
  rerender(<StableImage src="/third" alt="Cover" loading="lazy" />);
  const third = container.querySelector<HTMLImageElement>('img[src="/third"]')!;
  expect(third).toBe(first);
  fireEvent.load(third);
  await act(async () => undefined);
  expect(screen.getByRole("img")).toBe(third);
  expect(third.style.opacity).toBe("");
});

it("lets the area entrance own an image decoded during preparation", async () => {
  render(<div data-motion-view="assets" style={{opacity: 0}}><StableImage src="/first" alt="Cover"/></div>);
  const first = screen.getByRole<HTMLImageElement>("img"); first.animate = vi.fn();
  await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
  fireEvent.load(first); expect(first.animate).not.toHaveBeenCalled();
});

it("does not start a second image fade when the page releases its reveal marker during decode", async () => {
  const view = render(<div data-motion-view="series" style={{ opacity: 0 }}><StableImage src="/prepared" alt="Prepared" /></div>);
  const image = screen.getByRole<HTMLImageElement>("img");
  let finish!: () => void;
  image.decode = () => new Promise<void>(resolve => { finish = resolve; });
  image.animate = vi.fn();
  fireEvent.load(image);
  await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
  view.rerender(<div data-motion-view="series"><StableImage src="/prepared" alt="Prepared" /></div>);
  await act(async () => finish());
  expect(image.animate).not.toHaveBeenCalled();
  expect(image.style.opacity).toBe("");
});

it("loads a hidden lazy replacement without waiting for an intersection that cannot occur", async () => {
  const { container, rerender } = render(<StableImage src="/a" alt="Cover" loading="lazy" />);
  const first = screen.getByRole<HTMLImageElement>("img");
  fireEvent.load(first);
  rerender(<StableImage src="/b" alt="Cover" loading="lazy" />);
  const next = container.querySelector<HTMLImageElement>('img[src="/b"]')!;
  expect(next).toHaveAttribute("loading", "eager");
  let finish!: () => void;
  next.decode = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.load(next);
  expect(next.style.visibility).toBe("hidden");
  expect(screen.getByRole("img")).toBe(first);
  await act(async () => finish());
  expect(screen.getByRole("img")).toBe(next);
});

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

it("promotes either decoded neighbour's existing DOM slot and keeps it painted during a cold replacement", () => {
  const draw = (src: string, next?: string, previous?: string) => <StableImage src={src} alt={src} prefetchSrc={next} prefetchSecondarySrc={previous} />;
  const { container, rerender } = render(draw("/b", "/c", "/a"));
  const b = screen.getByRole("img");
  expect(container.querySelectorAll("img")).toHaveLength(1);
  fireEvent.load(b);
  const a = container.querySelector('img[src="/a"]')!;
  const c = container.querySelector('img[src="/c"]')!;
  fireEvent.load(a);
  fireEvent.load(c);
  expect(screen.getByRole("img")).toBe(b);
  rerender(draw("/a", "/b"));
  expect(screen.getByRole("img")).toBe(a);
  rerender(draw("/b", "/c", "/a"));
  expect(screen.getByRole("img")).toBe(b);
  rerender(draw("/c", "/d", "/b"));
  expect(screen.getByRole("img")).toBe(c);
  expect(container.querySelectorAll("img")).toHaveLength(3);
  rerender(draw("/e", "/f", "/d"));
  expect(screen.getByRole("img")).toBe(c);
  fireEvent.load(container.querySelector('img[src="/e"]')!);
  expect(screen.getByRole("img")).toHaveAttribute("src", "/e");
  expect(container.querySelectorAll("img")).toHaveLength(3);
});
