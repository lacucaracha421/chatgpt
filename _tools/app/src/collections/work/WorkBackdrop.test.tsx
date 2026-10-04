import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkBackdrop } from "./WorkBackdrop";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const image = (container: HTMLElement, src: string) => container.querySelector<HTMLImageElement>(`img[src="${src}"]`)!;

it.each([false, true])("keeps the old paint until decode and through the crossfade (reduced: %s)", async reduced => {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const ready = vi.fn(), view = render(<WorkBackdrop src="/one" onReady={ready} />);
  const old = image(view.container, "/one");
  await act(async () => fireEvent.load(old));
  act(() => vi.advanceTimersByTime(240));
  ready.mockClear();
  view.rerender(<WorkBackdrop src="/two" onReady={ready} />);
  const next = image(view.container, "/two");
  let decode!: () => void;
  Object.defineProperty(next, "decode", { value: () => new Promise<void>(resolve => { decode = resolve; }) });
  fireEvent.load(next);
  expect(old).toHaveClass("is-painted");
  expect(next).not.toHaveClass("is-painted");
  expect(ready).not.toHaveBeenCalled();
  await act(async () => decode());
  expect(old).toHaveClass("is-underlay");
  expect(next).toHaveClass("is-painted");
  expect(ready).toHaveBeenCalled();
  act(() => vi.advanceTimersByTime((reduced ? 120 : 240) - 1));
  expect(old).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(old).not.toBeInTheDocument();
  expect(next).toBeInTheDocument();
});

it("preserves both fading layers when another cover arrives and ignores its cancelled decode", async () => {
  const view = render(<WorkBackdrop src="/one" />);
  const first = image(view.container, "/one");
  await act(async () => fireEvent.load(first));
  view.rerender(<WorkBackdrop src="/two" />);
  const second = image(view.container, "/two");
  await act(async () => fireEvent.load(second));
  view.rerender(<WorkBackdrop src="/three" />);
  const cancelled = image(view.container, "/three");
  let decode!: () => void;
  Object.defineProperty(cancelled, "decode", { value: () => new Promise<void>(resolve => { decode = resolve; }) });
  fireEvent.load(cancelled);
  expect(first).toBeInTheDocument();
  expect(second).toHaveClass("is-painted");
  view.rerender(<WorkBackdrop src="/four" />);
  await act(async () => decode());
  expect(second).toHaveClass("is-painted");
  fireEvent.error(image(view.container, "/four"));
  act(() => vi.advanceTimersByTime(240));
  expect(second).toHaveClass("is-painted");
  expect(first).not.toBeInTheDocument();
});

it("settles a return to the already painted cover without waiting for another load", async () => {
  const ready = vi.fn(), view = render(<WorkBackdrop src="/one" onReady={ready} />);
  await act(async () => fireEvent.load(image(view.container, "/one")));
  view.rerender(<WorkBackdrop src="/two" onReady={ready} />);
  ready.mockClear();
  view.rerender(<WorkBackdrop src="/one" onReady={ready} />);
  expect(image(view.container, "/one")).toHaveClass("is-painted");
  expect(ready).toHaveBeenCalled();
});

it("prunes completed underlays during continuous decoded cover changes", async () => {
  const view = render(<WorkBackdrop src="/one" />);
  const first = image(view.container, "/one");
  await act(async () => fireEvent.load(first));
  act(() => vi.advanceTimersByTime(240));
  view.rerender(<WorkBackdrop src="/two" />);
  const second = image(view.container, "/two");
  await act(async () => fireEvent.load(second));
  act(() => vi.advanceTimersByTime(120));
  view.rerender(<WorkBackdrop src="/three" />);
  const third = image(view.container, "/three");
  await act(async () => fireEvent.load(third));
  act(() => vi.advanceTimersByTime(120));
  expect(first).not.toBeInTheDocument();
  expect(second).toHaveClass("is-underlay");
  expect(third).toHaveClass("is-painted");
  act(() => vi.advanceTimersByTime(120));
  expect(second).not.toBeInTheDocument();
  expect(third).toBeInTheDocument();
});
