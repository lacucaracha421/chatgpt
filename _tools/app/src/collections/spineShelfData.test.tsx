import { act, cleanup, render, screen } from "@testing-library/react";
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

function AvShelf({ items }: { items: CollectionSummary[] }) {
  const data = useSpineShelfWorks(items, "av", { enabled: true, gateway: {} as LibraryGateway, root: "lib", privacy: false, coverUrl: () => null });
  const groups = useMemo(() => shelfGroups(items, "sort").map(group => ({ label: group.label, works: group.items.map(data.toWork) })), [items, data.toWork]);
  return <div className="collection-browser__list-scroll">
    <SpineShelf groups={groups} scale={1.1} label="AV" pickedId={null} onPick={() => undefined} onOpen={() => undefined} onWindow={data.onWindow} prepare={data.prepare} />
  </div>;
}
const titles = () => screen.queryAllByRole("button").map(button => button.getAttribute("aria-label")!.split(" ·")[0]);
const inserts = () => document.querySelectorAll(".spine .ins").length;

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
