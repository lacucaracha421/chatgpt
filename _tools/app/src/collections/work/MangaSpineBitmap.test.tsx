import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MangaSpineBitmap } from "./MangaSpineBitmap";
import { requestSpineBitmap, type SpineBitmap } from "./mangaSpineBitmaps";
import { SpineBitmapLRU, spineBitmapKey, type SpineBitmapSpec } from "./mangaSpineBitmapCache";

vi.mock("./mangaSpineBitmaps", () => ({ requestSpineBitmap: vi.fn(() => () => {}) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const spec: SpineBitmapSpec = {
  id: "volume", art: "cover-64", scan: null, ink: "#45423e", title: "제목", author: "작가", publisher: "출판사", number: 1,
  width: 15, height: 200, print: 15.4, scale: 1, dpr: 1.25, zoom: 1, privacy: false, opacity: 1, focus: .4,
  numberMix: 4, titleFont: 10, labelFont: 4, authorFont: 4, publisherFont: 4, font: "Pretendard Variable",
};

it("keys identity, sources and each printed input independently of object property order", () => {
  const key = spineBitmapKey(spec);
  expect(spineBitmapKey({ ...spec })).toBe(key);
  const changes: Partial<SpineBitmapSpec>[] = [
    { id: "other" }, { art: "new-cover" }, { scan: "real-scan" }, { ink: "#123456" },
    { width: 16 }, { height: 228 }, { scale: 1.5 }, { dpr: 2 }, { privacy: true },
    { title: "수정" }, { author: null }, { publisher: null }, { number: 2 }, { focus: .7 },
    { opacity: .3 }, { numberMix: 8 }, { print: 18 }, { zoom: 1.2 }, { font: "other font" },
    { titleFont: 8 }, { labelFont: 3 }, { authorFont: 3 }, { publisherFont: 3 },
  ];
  for (const change of changes) expect(spineBitmapKey({ ...spec, ...change })).not.toBe(key);
});

it("evicts least recently used pixel memory, disposes replacements and rejects oversized entries", () => {
  const dispose = vi.fn();
  const cache = new SpineBitmapLRU<{ bytes: number; name: string }>(100, dispose);
  const a = { bytes: 40, name: "a" }, b = { bytes: 40, name: "b" }, c = { bytes: 50, name: "c" };
  cache.set("a", a); cache.set("b", b);
  expect(cache.get("a")).toBe(a); // Reading a protects it from b's eviction.
  cache.set("c", c);
  expect(cache.get("b")).toBeUndefined();
  expect(dispose).toHaveBeenCalledWith(b);
  expect(cache.get("a")).toBe(a);
  cache.set("a", { bytes: 20, name: "new a" });
  expect(dispose).toHaveBeenCalledWith(a);
  expect(cache.set("huge", { bytes: 101, name: "huge" })).toBe(false);
  expect(cache.get("c")).toBe(c);
});

it("keeps DOM print until the displayed bitmap slot decodes, then removes it atomically", async () => {
  let finish!: (value: SpineBitmap) => void;
  vi.mocked(requestSpineBitmap).mockImplementation((_spec, consumer) => { finish = consumer.done; return () => {}; });
  const view = render(<MangaSpineBitmap spec={spec}><span>Printed fallback</span></MangaSpineBitmap>);
  const fallback = view.getByText("Printed fallback"), image = view.container.querySelector("img")!;
  await act(async () => { finish({ url: "blob:spine", bytes: 100, ratio: null }); });
  expect(view.getByText("Printed fallback")).toBe(fallback);
  let decode!: () => void;
  image.decode = vi.fn(() => new Promise<void>(resolve => { decode = resolve; }));
  fireEvent.load(image);
  expect(view.getByText("Printed fallback")).toBe(fallback);
  await act(async () => { decode(); });
  expect(view.queryByText("Printed fallback")).toBeNull();
  expect(view.container.querySelector("img")).toBe(image);
  expect(image.style.visibility).not.toBe("hidden");
});

it("retains DOM on bitmap failure and ignores an old decode after privacy changes", async () => {
  let finish!: (value: SpineBitmap) => void;
  const cancel = vi.fn();
  vi.mocked(requestSpineBitmap).mockImplementation((_spec, consumer) => { finish = consumer.done; return cancel; });
  const view = render(<MangaSpineBitmap spec={spec}><span>Printed fallback</span></MangaSpineBitmap>);
  const image = view.container.querySelector("img")!;
  await act(async () => { finish({ url: "blob:old", bytes: 100, ratio: null }); });
  image.decode = vi.fn().mockRejectedValueOnce(new Error("decode failed"));
  await act(async () => { fireEvent.load(image); });
  expect(view.getByText("Printed fallback")).toBeTruthy();
  let decode!: () => void;
  image.decode = vi.fn(() => new Promise<void>(resolve => { decode = resolve; }));
  fireEvent.load(image);
  view.rerender(<MangaSpineBitmap spec={{ ...spec, privacy: true }}><span>Private paper</span></MangaSpineBitmap>);
  await act(async () => { decode(); });
  expect(view.getByText("Private paper")).toBeTruthy();
  expect(image.style.visibility).toBe("hidden");
  expect(cancel).toHaveBeenCalled();
});

it("uses a cheap first-mount paper block and restores the DOM when canvas is unavailable", async () => {
  let fail!: () => void;
  vi.mocked(requestSpineBitmap).mockImplementation((_spec, consumer) => { fail = consumer.failed!; return () => {}; });
  const view = render(<MangaSpineBitmap spec={spec} paperWhilePending><span>Printed fallback</span></MangaSpineBitmap>);
  expect(view.queryByText("Printed fallback")).toBeNull();
  expect(view.container.firstElementChild?.tagName).toBe("SPAN");
  await act(async () => { fail(); });
  expect(view.getByText("Printed fallback")).toBeTruthy();
});

it("decodes the actual slot again when returning to a previous print after a source change", async () => {
  let finish!: (value: SpineBitmap) => void;
  vi.mocked(requestSpineBitmap).mockImplementation((_spec, consumer) => { finish = consumer.done; return () => {}; });
  const face = (input: SpineBitmapSpec) => <MangaSpineBitmap spec={input}><span>Printed fallback</span></MangaSpineBitmap>;
  const view = render(face(spec));
  const image = view.container.querySelector("img")!;
  image.decode = vi.fn().mockResolvedValue(undefined);
  await act(async () => { finish({ url: "blob:first", bytes: 100, ratio: null }); });
  await act(async () => { fireEvent.load(image); });
  expect(view.queryByText("Printed fallback")).toBeNull();
  view.rerender(face({ ...spec, art: "replacement" }));
  view.rerender(face(spec));
  await act(async () => { finish({ url: "blob:first", bytes: 100, ratio: null }); });
  expect(view.getByText("Printed fallback")).toBeTruthy();
  await act(async () => { fireEvent.load(image); });
  expect(view.queryByText("Printed fallback")).toBeNull();
});
