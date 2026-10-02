import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { useCollectionCoverPerf } from "../collectionPerf";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CASE_PLASTIC, workCasePlatform, type CaseData } from "./CollectionCase";
import type { CollectionShelfCase as ShelfCase, CollectionSummary } from "../../library/types";
import { stripPosition } from "../work/coverStrip";
import { CollectionShelfCase, LightCase } from "./LightCase";

const gateway = vi.hoisted(() => ({ listCollectionShelfCases: vi.fn() }));
vi.mock("../../library/LibraryContext", () => ({ useLibrary: () => ({ gateway, library: null }) }));
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
beforeEach(() => {
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
});
function paintFrame() {
  act(() => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(16));
  });
}
async function showFirstBook(container: HTMLElement) {
  fireEvent.load(container.querySelector(".cs-front img")!);
  paintFrame(); paintFrame();
  await act(async () => { fireEvent.load(container.querySelector(".cs-spine img")!); });
}
afterEach(() => { cleanup(); frames.clear(); gateway.listCollectionShelfCases.mockReset(); vi.restoreAllMocks(); delete (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf; });
const book: CaseData = { title: "책 제목", platform: workCasePlatform("manga", null), front: "https://example.invalid/cover", spine: null, author: "작가 이름", privacy: false };

it("retains measured game cover geometry when the shelf remounts after a work closes", () => {
  const data: CaseData = { ...book, platform: "pc", front: "/geometry-game-cover" };
  const first = render(<LightCase data={data} selected={false} />);
  const image = first.container.querySelector<HTMLImageElement>(".cs-front img")!;
  Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 900 } });
  fireEvent.load(image);
  const ratio = first.container.querySelector<HTMLElement>(".collection-light-case")!.style.getPropertyValue("--case-ratio");
  expect(Number(ratio)).toBeCloseTo(2 / 3);
  first.unmount();
  const second = render(<LightCase data={data} selected={false} />);
  expect(second.container.querySelector<HTMLElement>(".collection-light-case")!.style.getPropertyValue("--case-ratio")).toBe(ratio);
});

it("prints the shared vertical title, front cover strip and author on a shelf book", () => {
  const { container } = render(<LightCase data={book} selected={false} />);
  const object = container.querySelector<HTMLElement>(".collection-light-case--book")!;
  expect(book.platform).toBe("book");
  expect(object.style.getPropertyValue("--plastic")).toBe(CASE_PLASTIC.book);
  expect(object.querySelector(".cs-front img")).toHaveAttribute("src", book.front);
  expect(object.querySelector(".manga-jspine-title")).toHaveTextContent(book.title);
  expect(object.querySelector(".manga-jspine-author")).toHaveTextContent(book.author!);
  fireEvent.load(object.querySelector(".cs-front img")!);
  paintFrame(); paintFrame();
  expect(object.querySelector(".cs-spine img")).toHaveAttribute("src", object.querySelector(".cs-front img")!.getAttribute("src"));
  expect(object.querySelector<HTMLImageElement>(".cs-spine img")!.style.objectPosition).toBe("50% 30%");
  expect(object.querySelector(".tpl, .manga-jspine-number, .manga-jspine-ruler")).toBeNull();
});

it("masks both book faces in privacy mode and keeps the selection lift", () => {
  const { container } = render(<LightCase data={{ ...book, privacy: true }} selected />);
  const object = container.querySelector(".collection-light-case--book")!;
  expect(object).toHaveAttribute("data-front");
  expect(object.querySelectorAll(".case-mask")).toHaveLength(2);
  expect(object.querySelector("img, .manga-jspine")).toBeNull();
});

it("passes the PC summary author without fetching manga detail or guessing a volume number", () => {
  const collection = { id: "manga", name: book.title, type: "manga", author: book.author, publisher: null, platforms: null, updatedAt: "r1" } as CollectionSummary;
  const { container } = render(<CollectionShelfCase collection={collection} front={book.front} privacy={false} active selected={false} />);
  expect(container.querySelector(".manga-jspine-author")).toHaveTextContent(book.author!);
  expect(container.querySelector(".cs-spine img")).toBeNull();
  fireEvent.load(container.querySelector(".cs-front img")!);
  paintFrame(); paintFrame();
  expect(container.querySelector(".cs-spine img")).toHaveAttribute("src", book.front);
  expect(container.querySelector(".manga-jspine-number")).toBeNull();
});

it("keeps both faces until both replacement elements decode, and reuses a previously painted cover", async () => {
  const { container, rerender } = render(<LightCase data={book} selected={false} />);
  const images = (src: string) => [...container.querySelectorAll<HTMLImageElement>("img")].filter(image => image.getAttribute("src") === src);
  await showFirstBook(container);
  const first = images(book.front!);
  expect(first.every(image => image.style.visibility === "")).toBe(true);
  rerender(<LightCase data={{ ...book, front: "/next" }} selected={false} />);
  const next = images("/next");
  let decoded!: () => void;
  Object.defineProperty(next[1], "decode", { value: () => new Promise<void>(resolve => { decoded = resolve; }) });
  await act(async () => next.forEach(image => fireEvent.load(image)));
  expect(first.every(image => image.style.visibility === "")).toBe(true);
  expect(next.every(image => image.style.visibility === "hidden")).toBe(true);
  await act(async () => decoded());
  expect(next.every(image => image.style.visibility === "")).toBe(true);
  expect(first.every(image => image.style.visibility === "hidden")).toBe(true);
  rerender(<LightCase data={book} selected={false} />);
  expect(first.every(image => image.style.visibility === "")).toBe(true);
  expect(next.every(image => image.style.visibility === "hidden")).toBe(true);
});

it("uses the passed cover focus without measuring shelf text or creating observers", () => {
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const { container } = render(<LightCase data={{ ...book, coverFocus: .25, volumeNumber: 1 }} selected={false} />);
  fireEvent.load(container.querySelector(".cs-front img")!);
  paintFrame(); paintFrame();
  expect(container.querySelector<HTMLImageElement>(".cs-spine img")!.style.objectPosition).toBe(`${stripPosition(.25, .71, .08)}% 30%`);
  expect(container.querySelector(".manga-jspine-number")).toHaveTextContent("1");
  expect(container.querySelector(".manga-jspine-ruler")).toBeNull();
  expect(measure).not.toHaveBeenCalled();
});

it("retains the painted front and strip if the new strip fails", async () => {
  const { container, rerender } = render(<LightCase data={book} selected={false} />);
  await showFirstBook(container);
  const first = [...container.querySelectorAll<HTMLImageElement>("img")];
  rerender(<LightCase data={{ ...book, front: "/bad" }} selected={false} />);
  const next = [...container.querySelectorAll<HTMLImageElement>('img[src="/bad"]')];
  await act(async () => { fireEvent.load(next[0]); fireEvent.error(next[1]); });
  expect(first.every(image => image.style.visibility === "")).toBe(true);
  expect(next.every(image => image.style.visibility === "hidden")).toBe(true);
});

it("ignores stale replacement decodes when a source changes away and back", async () => {
  const { container, rerender } = render(<LightCase data={book} selected={false} />);
  await showFirstBook(container);
  const original = container.querySelector<HTMLImageElement>(".cs-front img")!;
  rerender(<LightCase data={{ ...book, front: "/next" }} selected={false} />);
  const front = container.querySelector<HTMLImageElement>('.cs-front img[src="/next"]')!;
  const pending: (() => void)[] = [];
  Object.defineProperty(front, "decode", { value: () => new Promise<void>(resolve => pending.push(resolve)) });
  fireEvent.load(front);
  rerender(<LightCase data={{ ...book, front: "/other" }} selected={false} />);
  rerender(<LightCase data={{ ...book, front: "/next" }} selected={false} />);
  await act(async () => container.querySelectorAll('img[src="/next"]').forEach(image => fireEvent.load(image)));
  await act(async () => pending[0]());
  expect(front.style.visibility).toBe("hidden");
  expect(original.style.visibility).toBe("");
  await act(async () => pending[1]());
  expect(front.style.visibility).toBe("");
  expect(container.querySelector<HTMLImageElement>('.cs-spine img[src="/next"]')!.style.visibility).toBe("");
});

it("shows the first book front on load without waiting for decode or the strip", () => {
  const { container } = render(<LightCase data={book} selected={false} />);
  const front = container.querySelector<HTMLImageElement>(".cs-front img")!;
  front.decode = vi.fn(() => new Promise<void>(() => {}));
  expect(container.querySelector(".cs-spine img")).toBeNull();
  fireEvent.load(front);
  expect(front.decode).not.toHaveBeenCalled();
  expect(front.style.visibility).toBe("");
  expect(front).toHaveAttribute("decoding", "async");
  paintFrame();
  expect(container.querySelector(".cs-spine img")).toBeNull();
  paintFrame();
  expect(container.querySelector(".cs-spine img")).toHaveAttribute("src", book.front);
  expect(container.querySelector(".cs-front img")).toBe(front);
});

it.each(["load", "error"] as const)("defers a material spine until after the front %s", event => {
  const data: CaseData = { ...book, platform: "pc", spine: "/spine" };
  const { container, unmount } = render(<LightCase data={data} selected={false} />);
  const front = container.querySelector<HTMLImageElement>(".cs-front img")!;
  front.decode = vi.fn(() => new Promise<void>(() => {}));
  expect(container.querySelector(".cs-spine img")).toBeNull();
  fireEvent[event](front);
  expect(front.decode).not.toHaveBeenCalled();
  paintFrame();
  expect(container.querySelector(".cs-spine img")).toBeNull();
  paintFrame();
  expect(container.querySelector(".cs-spine img")).toHaveAttribute("src", "/spine");
  expect(container.querySelector(".cs-spine img")).toHaveAttribute("loading", "lazy");
  unmount();
  expect(frames.size).toBe(0);
});

it("finishes the first strip while a replacement is pending and can return to that front", async () => {
  const { container, rerender } = render(<LightCase data={book} selected={false} />);
  const front = container.querySelector<HTMLImageElement>(".cs-front img")!;
  fireEvent.load(front);
  paintFrame(); paintFrame();
  const strip = container.querySelector<HTMLImageElement>(".cs-spine img")!;
  rerender(<LightCase data={{ ...book, front: "/slow-next" }} selected={false} />);
  fireEvent.load(strip);
  expect(front.style.visibility).toBe("");
  expect(strip.style.visibility).toBe("");
  rerender(<LightCase data={book} selected={false} />);
  expect(container.querySelector(".cs-front img")).toBe(front);
  expect(strip.style.visibility).toBe("");
});

it("admits a spine without a front in StrictMode and cancels pending work on unmount", () => {
  const data: CaseData = { ...book, platform: "pc", front: null, spine: "/spine-only" };
  const first = render(<StrictMode><LightCase data={data} selected={false} /></StrictMode>);
  paintFrame();
  expect(first.container.querySelector("img")).toBeNull();
  first.unmount();
  expect(frames.size).toBe(0);
  const second = render(<StrictMode><LightCase data={data} selected={false} /></StrictMode>);
  paintFrame(); paintFrame();
  expect(second.container.querySelector("img")).toHaveAttribute("src", "/spine-only");
});

it("commits the cold front src before shelf metadata resolves, with the same image retained", async () => {
  (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf = {};
  let resolve!: (value: ShelfCase[]) => void;
  gateway.listCollectionShelfCases.mockReturnValue(new Promise<ShelfCase[]>(done => { resolve = done; }));
  const timing = vi.spyOn(performance, "measure");
  const collection = { id: "cold-game", name: "Cold game", type: "game", platforms: "PC", updatedAt: "r1" } as CollectionSummary;
  function ColdShelf() {
    const root = useRef<HTMLDivElement>(null);
    useCollectionCoverPerf(root, "cold", collection);
    return <div ref={root}><CollectionShelfCase collection={collection} front="/cold-front" privacy={false} active selected={false} /></div>;
  }
  const { container } = render(<ColdShelf />);
  const image = container.querySelector<HTMLImageElement>(".cs-front img")!;
  expect(image).toHaveAttribute("src", "/cold-front");
  expect(image).not.toHaveAttribute("loading", "lazy");
  expect(timing.mock.calls.map(([name]) => name)).toContain("w4:collections.first-cover.src-assigned");
  await act(async () => {});
  expect(gateway.listCollectionShelfCases).toHaveBeenCalledOnce();
  expect(timing.mock.calls.map(([name]) => name)).toContain("w4:collections.ipc.list_collection_shelf_cases.dispatched");
  expect(timing.mock.calls.map(([name]) => name)).not.toContain("w4:collections.ipc.list_collection_shelf_cases.arrived");
  await act(async () => resolve([{ collectionId: collection.id, ownedPlatform: "PS5", spineArtworkId: null }]));
  expect(container.querySelector(".cs-front img")).toBe(image);
  expect(image).toHaveAttribute("src", "/cold-front");
  expect(timing.mock.calls.map(([name]) => name)).toContain("w4:collections.ipc.list_collection_shelf_cases.arrived");
});
