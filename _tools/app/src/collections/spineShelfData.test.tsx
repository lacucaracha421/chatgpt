import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { spineScale } from "./case/caseDimensions";
import { useMemo } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CollectionSummary, LibraryGateway } from "../library/types";
import { avGateway } from "./avClient";
import { shelfGroups } from "./CollectionList";
import { SpineShelf } from "./SpineShelf";
import { resetSpineShelfDataForTests, useSpineShelfWorks } from "./spineShelfData";
import { resetSpineWarmForTests } from "./spineShelfWarm";

type Sets = Awaited<ReturnType<NonNullable<typeof avGateway.listCoverSets>>>;
const item = (id: string) => ({ id, name: `작품 ${id}`, type: "av", updatedAt: "1" }) as unknown as CollectionSummary;
const sets = (...ids: string[]): Sets => ids.map(id => ({ collectionId: id, frontId: null, spineId: `s-${id}`, backId: null, revision: "r" }));

function AvShelf({ items, picked = null, scale = 1.1 }: { items: CollectionSummary[]; picked?: string | null; scale?: number }) {
  const data = useSpineShelfWorks(items, "av", { enabled: true, gateway: {} as LibraryGateway, root: "lib", privacy: false, coverUrl: () => null, scale });
  const groups = useMemo(() => shelfGroups(items, "sort").map(group => ({ label: group.label, works: group.items.map(data.toWork) })), [items, data.toWork]);
  return <div className="collection-browser__list-scroll">
    <SpineShelf groups={groups} scale={scale} label="AV" pickedId={picked} onPick={() => undefined} onOpen={() => undefined} onWindow={data.onWindow} prepare={data.prepare} />
  </div>;
}
const titles = () => screen.queryAllByRole("button").map(button => button.getAttribute("aria-label")!.split(" ·")[0]);
const inserts = () => document.querySelectorAll(".spine .ins").length;

it("makes movie boards from existing posters and their decoded dimensions without reading game or AV data", async () => {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(707);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(1000);
  const movie = { ...item("movie"), type: "movie" as const, year: 2024, selectedWorkArtworkId: "poster" };
  const gameRead = vi.fn().mockResolvedValue([]);
  const gateway = { listCollectionShelfCases: gameRead } as unknown as LibraryGateway;
  const avRead = vi.spyOn(avGateway, "listCoverSets");
  const { result } = renderHook(() => useSpineShelfWorks([movie], "movie", {
    enabled: true, gateway, root: "lib", privacy: false, coverUrl: () => "/poster",
  }));
  const work = result.current.toWork(movie);
  expect(work).toMatchObject({ platform: "film", year: 2024, spine: "/poster", pending: false });
  const sizes = await result.current.prepare?.([movie.id], [movie.id], new AbortController().signal);
  expect(sizes?.get(movie.id)?.height).toBeCloseTo(125 / .707);
  expect(avRead).not.toHaveBeenCalled();
  expect(gameRead).not.toHaveBeenCalled();
});

let decodes: string[];
beforeEach(() => {
  decodes = [];
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("collection-browser__list-scroll") ? 800 : 0; });
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value(this: HTMLImageElement) { decodes.push(this.src); return Promise.resolve(); } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.useRealTimers();
  resetSpineShelfDataForTests(); resetSpineWarmForTests();
  delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
});

it("keeps the old AV spines while the new order's spines are read and decoded, then shows the new order at once", async () => {
  const answers: ((value: Sets) => void)[] = [];
  const read = vi.spyOn(avGateway, "listCoverSets").mockImplementation(() => new Promise<Sets>(resolve => { answers.push(resolve); }));
  const { rerender } = render(<AvShelf items={[item("a1"), item("a2")]} />);
  await act(async () => answers[0](sets("a1", "a2")));
  expect(titles()).toEqual(["작품 a1", "작품 a2"]);
  expect(inserts()).toBe(2);

  rerender(<AvShelf items={[item("b1"), item("b2")]} />);
  // The new works are being read; the old shelf is still the one on screen, spines and all.
  expect(titles()).toEqual(["작품 a1", "작품 a2"]);
  expect(inserts()).toBe(2);
  await act(async () => answers[1](sets("b1", "b2")));
  expect(titles()).toEqual(["작품 b1", "작품 b2"]);
  // The swap came with their artwork: no plastic spine waits for a read.
  expect(inserts()).toBe(2);
  expect(decodes.some(url => url.includes("s-b1")) && decodes.some(url => url.includes("s-b2"))).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
});

it("swaps to the new order after the wait when the read is slow, and lets the spines arrive later", async () => {
  vi.useFakeTimers();
  const answers: ((value: Sets) => void)[] = [];
  vi.spyOn(avGateway, "listCoverSets").mockImplementation(() => new Promise<Sets>(resolve => { answers.push(resolve); }));
  const { rerender } = render(<AvShelf items={[item("a1")]} />);
  await act(async () => answers[0](sets("a1")));
  rerender(<AvShelf items={[item("b1")]} />);
  act(() => { vi.advanceTimersByTime(650); });
  expect(titles()).toEqual(["작품 a1"]);
  act(() => { vi.advanceTimersByTime(100); });
  expect(titles()).toEqual(["작품 b1"]);
  expect(inserts()).toBe(0);
  await act(async () => answers[1](sets("b1")));
  expect(inserts()).toBe(1);
});

it("shows a revisited order immediately, from what was read before", async () => {
  const read = vi.spyOn(avGateway, "listCoverSets").mockImplementation(ids => Promise.resolve(sets(...ids)));
  const a = [item("a1"), item("a2")];
  const { rerender } = render(<AvShelf items={a} />);
  await act(async () => undefined);
  rerender(<AvShelf items={[item("b1"), item("b2")]} />);
  await act(async () => undefined);
  expect(titles()).toEqual(["작품 b1", "작품 b2"]);
  read.mockClear();
  rerender(<AvShelf items={[a[1], a[0]]} />);
  expect(titles()).toEqual(["작품 a2", "작품 a1"]);
  expect(inserts()).toBe(2);
  expect(read).not.toHaveBeenCalled();
});

it("prints the stored AV back cover on the pulled-out case, as the work screen does", async () => {
  vi.spyOn(avGateway, "listCoverSets").mockResolvedValue([{ collectionId: "a1", frontId: "f-a1", spineId: "s-a1", backId: "b-a1", revision: "r" }]);
  render(<AvShelf items={[item("a1")]} picked="a1" />);
  const back = await screen.findByRole("img", { name: "작품 a1 뒷면" });
  expect(back.getAttribute("src")).toContain("b-a1");
  // Not the generated back the case prints for a work without back artwork.
  expect(document.querySelector(".spine-shelf__out .case-back")).toBeNull();
});

it("draws AV spines from the stored artwork where the shelf is taller than their thumbnails, and keeps thumbnails below that", async () => {
  vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(1.5);
  vi.spyOn(avGateway, "listCoverSets").mockResolvedValue([{ collectionId: "a1", frontId: "f-a1", spineId: "s-a1", backId: null, revision: "r" }]);
  // 작게 on the PC (190 mm at 1 px/mm, 285 device px): the 360px thumbnail is enough.
  const { unmount } = render(<AvShelf items={[item("a1")]} scale={spineScale("pc", "av", "small")} />);
  await waitFor(() => expect(document.querySelector(".spine img")).not.toBeNull());
  expect(document.querySelector(".spine img")!.getAttribute("src")).toContain("work-artwork-thumbnail/s-a1");
  unmount(); resetSpineShelfDataForTests();
  // 크게 (1.8 px/mm, 513 device px): the stored spine itself.
  render(<AvShelf items={[item("a1")]} scale={spineScale("pc", "av", "large")} />);
  await waitFor(() => expect(document.querySelector(".spine img")).not.toBeNull());
  expect(document.querySelector(".spine img")!.getAttribute("src")).toMatch(/\/work-artwork\/s-a1/);
});

it("stands AV cases larger than games at every 책등 크기", () => {
  for (const size of ["small", "normal", "large"] as const) expect(spineScale("pc", "av", size)).toBeGreaterThan(spineScale("pc", "game", size));
  expect(spineScale("tablet", "av", "large")).toBeGreaterThan(spineScale("tablet", "game", "large"));
});
