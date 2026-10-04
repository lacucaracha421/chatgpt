import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { useCollectionCoverPerf } from "../collectionPerf";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CASE_PLASTIC, workCasePlatform, type CaseData } from "./CollectionCase";
import type { CollectionShelfCase as ShelfCase, CollectionSummary } from "../../library/types";
import { stripPosition } from "../work/coverStrip";
import { CollectionShelfCase, LightCase } from "./LightCase";
import { READY_CAP_MS } from "../../shared/motion/AreaSwitch";
import { readFileSync } from "node:fs";

const gateway = vi.hoisted(() => ({ listCollectionShelfCases: vi.fn() }));
const av = vi.hoisted(() => ({ getCoverSet: vi.fn() }));
vi.mock("../../library/LibraryContext", () => ({ useLibrary: () => ({ gateway, library: null }) }));
vi.mock("../avClient", () => ({ avGateway: av }));
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
afterEach(() => { cleanup(); vi.useRealTimers(); frames.clear(); gateway.listCollectionShelfCases.mockReset(); av.getCoverSet.mockReset(); vi.restoreAllMocks(); delete (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf; });
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
  expect(container.querySelector(".cs-spine img")).toHaveStyle({ visibility: "hidden" });
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

it.each(["book", "pc"] as const)("reveals the first %s front and spine together only after both actual elements decode", async platform => {
  const data = { ...book, platform, front: `/first-${platform}`, spine: `/spine-${platform}` };
  const { container } = render(<LightCase data={data} selected={false} />);
  const object = container.querySelector(".collection-light-case")!;
  const front = container.querySelector<HTMLImageElement>(".cs-front img")!;
  const spine = container.querySelector<HTMLImageElement>(".cs-spine img")!;
  let frontDecoded!: () => void, spineDecoded!: () => void;
  front.decode = vi.fn(() => new Promise<void>(resolve => { frontDecoded = resolve; }));
  spine.decode = vi.fn(() => new Promise<void>(resolve => { spineDecoded = resolve; }));
  fireEvent.load(front); fireEvent.load(spine);
  expect(object).toHaveAttribute("data-revealed", "false");
  await act(async () => frontDecoded());
  expect(front.style.visibility).toBe("hidden");
  expect(spine.style.visibility).toBe("hidden");
  if (platform === "book") expect(container.querySelector(".manga-jspine-title")).not.toBeVisible();
  await act(async () => spineDecoded());
  expect(object).toHaveAttribute("data-ready", "true");
  expect(front.style.visibility).toBe("");
  expect(spine.style.visibility).toBe("");
  expect(frames.size).toBe(0);
});

it("holds the plain DOM spine until the front decodes, then caps a stalled front without a broken image", () => {
  const { container } = render(<LightCase data={{ ...book, platform: "pc", front: "/stalled" }} selected={false} />);
  const front = container.querySelector<HTMLImageElement>(".cs-front img")!;
  expect(container.querySelector(".spine-title")).toBeNull();
  fireEvent.error(front);
  act(() => vi.advanceTimersByTime(READY_CAP_MS - 1));
  expect(container.querySelector(".spine-title")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(container.querySelector(".spine-title")).toBeVisible();
  expect(front.style.visibility).toBe("hidden");
  expect(container.querySelector(".collection-light-case")).toHaveAttribute("aria-busy", "false");
  fireEvent.load(front);
  expect(front.style.visibility).toBe("");
});

it.each(["book", "pc"] as const)("caps a slow %s spine, then fills it without blanking the front", async platform => {
  const { container } = render(<LightCase data={{ ...book, platform, front: `/cap-${platform}`, spine: `/cap-spine-${platform}` }} selected={false} />);
  const front = container.querySelector<HTMLImageElement>(".cs-front img")!;
  const spine = container.querySelector<HTMLImageElement>(".cs-spine img")!;
  let decoded!: () => void;
  spine.decode = () => new Promise<void>(resolve => { decoded = resolve; });
  fireEvent.load(front); fireEvent.load(spine);
  act(() => vi.advanceTimersByTime(READY_CAP_MS - 1));
  expect(front.style.visibility).toBe("hidden");
  act(() => vi.advanceTimersByTime(1));
  expect(front.style.visibility).toBe("");
  expect(spine.style.visibility).toBe("hidden");
  await act(async () => decoded());
  expect(container.querySelector(".cs-front img")).toBe(front);
  expect(front.style.visibility).toBe("");
  expect(spine.style.visibility).toBe("");
});

it.each(["book", "pc"] as const)("shows a cached %s revisit complete before paint without load events or timers", platform => {
  const data = { ...book, platform, front: `/cached-${platform}`, spine: `/cached-spine-${platform}` };
  const first = render(<LightCase data={data} selected={false} />);
  first.container.querySelectorAll("img").forEach(image => {
    Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 900 } });
    fireEvent.load(image);
  });
  first.unmount();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(900);
  const second = render(<LightCase data={data} selected={false} />);
  expect(second.container.querySelector(".collection-light-case")).toHaveAttribute("data-ready", "true");
  expect([...second.container.querySelectorAll<HTMLImageElement>("img")].every(image => image.style.visibility === "")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(frames.size).toBe(0);
});

it("does not mistake an evicted browser image for a decoded revisit", () => {
  const data = { ...book, front: "/evicted" };
  const first = render(<LightCase data={data} selected={false} />);
  first.container.querySelectorAll("img").forEach(image => fireEvent.load(image));
  first.unmount();
  const second = render(<LightCase data={data} selected={false} />);
  expect(second.container.querySelector(".collection-light-case")).toHaveAttribute("data-revealed", "false");
});

it("keeps both previous faces through the replacement cap and preserves the missing face until it decodes", () => {
  const { container, rerender } = render(<LightCase data={{ ...book, platform: "pc", front: "/held-front", spine: "/held-spine" }} selected={false} />);
  const previous = [...container.querySelectorAll<HTMLImageElement>("img")];
  previous.forEach(image => fireEvent.load(image));
  rerender(<LightCase data={{ ...book, platform: "pc", front: "/new-front", spine: "/new-spine" }} selected={false} />);
  const front = container.querySelector<HTMLImageElement>('img[src="/new-front"]')!;
  const spine = container.querySelector<HTMLImageElement>('img[src="/new-spine"]')!;
  fireEvent.load(front);
  expect(previous.every(image => image.style.visibility === "")).toBe(true);
  act(() => vi.advanceTimersByTime(READY_CAP_MS));
  expect(front.style.visibility).toBe("");
  expect(previous[1].style.visibility).toBe("");
  expect(spine.style.visibility).toBe("hidden");
  fireEvent.load(spine);
  expect(spine.style.visibility).toBe("");
  expect(previous.every(image => image.style.visibility === "hidden")).toBe(true);
});

it("gives a new replacement its own gate after an earlier source timed out", () => {
  const { container, rerender } = render(<LightCase data={{ ...book, front: "/timed-out" }} selected={false} />);
  fireEvent.load(container.querySelector(".cs-front img")!);
  act(() => vi.advanceTimersByTime(READY_CAP_MS));
  rerender(<LightCase data={{ ...book, front: "/after-timeout" }} selected={false} />);
  const next = [...container.querySelectorAll<HTMLImageElement>('img[src="/after-timeout"]')];
  fireEvent.load(next[0]);
  expect(next.every(image => image.style.visibility === "hidden")).toBe(true);
  fireEvent.load(next[1]);
  expect(next.every(image => image.style.visibility === "")).toBe(true);
});

it("reveals ready items independently of a slow neighbour", () => {
  const { container } = render(<><LightCase data={{ ...book, front: "/quick" }} selected={false} /><LightCase data={{ ...book, front: "/slow" }} selected={false} /></>);
  container.querySelectorAll('img[src="/quick"]').forEach(image => fireEvent.load(image));
  const cases = container.querySelectorAll(".collection-light-case");
  expect(cases[0]).toHaveAttribute("data-ready", "true");
  expect(cases[1]).toHaveAttribute("data-revealed", "false");
});

it("keeps a completely failed item neutral and ends the initial wait at the cap", () => {
  const { container } = render(<LightCase data={{ ...book, front: "/both-failed" }} selected={false} />);
  container.querySelectorAll("img").forEach(image => fireEvent.error(image));
  act(() => vi.advanceTimersByTime(READY_CAP_MS));
  expect(container.querySelector(".collection-light-case")).toHaveAttribute("aria-busy", "false");
  expect([...container.querySelectorAll<HTMLImageElement>("img")].every(image => image.style.visibility === "hidden")).toBe(true);
  expect(container.querySelector(".manga-jspine-title")).not.toBeVisible();
});

it("keeps the reserved shelf size and DOM frame from placeholder through the cap and completion", () => {
  const { container } = render(<LightCase data={{ ...book, front: "/sized" }} selected={false} />);
  const frame = container.querySelector<HTMLElement>(".collection-light-case")!;
  const box = frame.querySelector(".cs-box");
  const style = frame.getAttribute("style");
  const front = frame.querySelector<HTMLImageElement>(".cs-front img")!;
  Object.defineProperties(front, { naturalWidth: { value: 600 }, naturalHeight: { value: 900 } });
  fireEvent.load(front);
  expect(frame.getAttribute("style")).toBe(style);
  act(() => vi.advanceTimersByTime(READY_CAP_MS));
  expect(Number(frame.style.getPropertyValue("--case-ratio"))).toBeCloseTo(2 / 3);
  const finishedStyle = frame.getAttribute("style");
  fireEvent.load(frame.querySelector(".cs-spine img")!);
  expect(frame.getAttribute("style")).toBe(finishedStyle);
  expect(container.querySelector(".collection-light-case")).toBe(frame);
  expect(frame.querySelector(".cs-box")).toBe(box);
  // jsdom has no layout: assert the geometry contract too, not zero-valued rects.
  const css = readFileSync("src/collections/case/LightCase.css", "utf8");
  expect(css).toMatch(/\.collection-light-case \{[^}]*height: var\(--case-height\)/);
  expect(css).toMatch(/\.collection-light-case \.cs-box \{[^}]*position: absolute/);
});

it("admits a spine without a front in StrictMode and cancels pending work on unmount", () => {
  const data: CaseData = { ...book, platform: "pc", front: null, spine: "/spine-only" };
  const first = render(<StrictMode><LightCase data={data} selected={false} /></StrictMode>);
  expect(first.container.querySelector("img")).toHaveStyle({ visibility: "hidden" });
  first.unmount();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const second = render(<StrictMode><LightCase data={data} selected={false} /></StrictMode>);
  fireEvent.load(second.container.querySelector("img")!);
  expect(second.container.querySelector("img")).toHaveAttribute("src", "/spine-only");
  expect(second.container.querySelector("img")).toHaveStyle({ visibility: "visible" });
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
  fireEvent.load(image);
  expect(image.style.visibility).toBe("hidden");
  await act(async () => resolve([{ collectionId: collection.id, ownedPlatform: "PS5", spineArtworkId: null }]));
  expect(container.querySelector(".cs-front img")).toBe(image);
  expect(image).toHaveAttribute("src", "/cold-front");
  expect(image.style.visibility).toBe("");
  expect(timing.mock.calls.map(([name]) => name)).toContain("w4:collections.ipc.list_collection_shelf_cases.arrived");
});

it("holds a PC front for late spine metadata, then swaps both faces together", async () => {
  let resolve!: (value: ShelfCase[]) => void;
  gateway.listCollectionShelfCases.mockReturnValue(new Promise<ShelfCase[]>(done => { resolve = done; }));
  const collection = { id: "late-spine-game", name: "Game", type: "game", platforms: "PC", updatedAt: "r1" } as CollectionSummary;
  const { container } = render(<CollectionShelfCase collection={collection} front="/late-front" privacy={false} active selected={false} />);
  const front = container.querySelector<HTMLImageElement>(".cs-front img")!;
  fireEvent.load(front);
  expect(front.style.visibility).toBe("hidden");
  await act(async () => resolve([{ collectionId: collection.id, ownedPlatform: "PS5", spineArtworkId: "late-spine" }]));
  expect(front.style.visibility).toBe("hidden");
  fireEvent.load(container.querySelector(".cs-spine img")!);
  expect(front.style.visibility).toBe("");
  expect(container.querySelector(".collection-light-case")).toHaveAttribute("data-ready", "true");
});

it("reuses AV artwork choices on a warm remount without waiting for metadata again", async () => {
  const collection = { id: "cached-av", name: "AV", type: "av", updatedAt: "r1" } as CollectionSummary;
  av.getCoverSet.mockResolvedValue({ frontId: "av-front", spineId: "av-spine", revision: "r1" });
  const first = render(<CollectionShelfCase collection={collection} front={null} privacy={false} active selected={false} />);
  await act(async () => {});
  first.container.querySelectorAll("img").forEach(image => {
    Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 900 } });
    fireEvent.load(image);
  });
  first.unmount();
  av.getCoverSet.mockReturnValue(new Promise(() => {}));
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(900);
  const second = render(<CollectionShelfCase collection={collection} front={null} privacy={false} active selected={false} />);
  expect(second.container.querySelector(".collection-light-case")).toHaveAttribute("data-ready", "true");
  expect(vi.getTimerCount()).toBe(0);
});
