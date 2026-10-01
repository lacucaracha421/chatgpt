import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionSummary, CollectionType } from "../library/types";
import { CollectionList, shelfGroups, useCollectionView } from "./CollectionList";

const works = Array.from({ length: 24 }, (_, index) => ({ id: `work-${index}`, name: `작품 ${index}`, type: "game", platforms: "Switch 2", year: 2026 - Math.floor(index / 8) })) as CollectionSummary[];
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
it("respects every count in shelf and grid without remounting the cells", () => {
  const draw = (layout: "grid" | "shelf", perRow: number) => <CollectionList items={works} view={{ layout, perRow, grouping: "device" }} label="작품" onPick={() => undefined} render={work => <button data-collection-id={work.id}>{work.name}</button>} />;
  const { container, rerender } = render(draw("shelf", 8));
  const first = container.querySelector('[data-collection-id="work-0"]');
  for (const layout of ["shelf", "grid"] as const) for (let count = 5; count <= 12; count++) {
    rerender(draw(layout, count));
    const rows = new Map<string, number>();
    container.querySelectorAll<HTMLElement>(".collection-list__cell").forEach(cell => rows.set(cell.style.gridRow, (rows.get(cell.style.gridRow) ?? 0) + 1));
    const counts = [...rows.values()];
    expect(counts.slice(0, -1).every(value => value === count)).toBe(true);
    expect(counts[counts.length - 1]).toBeLessThanOrEqual(count);
    expect(container.querySelector('[data-collection-id="work-0"]')).toBe(first);
  }
});
it("keeps showcase on a single plank with all its cells mounted", () => {
  const { container } = render(<CollectionList items={works} showcase view={{ layout: "shelf", perRow: 8, grouping: "device" }} label="쇼케이스" onPick={() => undefined} render={work => <button>{work.name}</button>} />);
  expect(container.querySelectorAll(".collection-list__plank")).toHaveLength(1);
  expect(new Set([...container.querySelectorAll<HTMLElement>(".collection-list__cell")].map(cell => cell.style.gridRow)).size).toBe(1);
});
it("persists layout and count independently for each collection type", () => {
  const { result, rerender, unmount } = renderHook(({ type }: { type: CollectionType }) => useCollectionView(type), { initialProps: { type: "game" as CollectionType } });
  act(() => result.current[1]({ layout: "grid", perRow: 6 }));
  rerender({ type: "movie" });
  expect(result.current[0]).toMatchObject({ layout: "shelf", perRow: 8 });
  act(() => result.current[1]({ perRow: 12 }));
  rerender({ type: "game" });
  expect(result.current[0]).toMatchObject({ layout: "grid", perRow: 6 });
  unmount();
  const restored = renderHook(() => useCollectionView("movie"));
  expect(restored.result.current[0].perRow).toBe(12);
});
it("groups games by device or release year, preserving other media's current order", () => {
  const ps = { ...works[0], id: "ps", platforms: "PlayStation 5" };
  expect(shelfGroups([...works, ps], "device").map(group => [group.label, group.items.length])).toEqual([["닌텐도", 24], ["PS · Xbox · PC", 1]]);
  expect(shelfGroups(works, "year").map(group => group.label)).toEqual(["2026", "2025", "2024"]);
  const films = works.map(work => ({ ...work, type: "movie" as const }));
  expect(shelfGroups(films, "device")[0].items).toBe(films);
});

// A 1440px list with 500px available below the collection chrome. jsdom has no layout:
// supply rectangles from the grid's card tracks and group headings.
function shelfGeometry() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1440);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) {
    return this.classList.contains("collection-browser__list-scroll") ? 500 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const root = this.closest<HTMLElement>(".collection-browser__list-scroll");
    const list = this.closest<HTMLElement>(".collection-list");
    let top = 0, height = 500;
    if (this.classList.contains("collection-list__cell") && list) {
      const cardHeight = parseFloat(list.style.getPropertyValue("--case-height")) + 64;
      const groupRows = new Set([...list.querySelectorAll<HTMLElement>(".collection-list__group")].map(group => Number(group.style.gridRow)));
      const row = Number(this.style.gridRow);
      top = 16 - (root?.scrollTop ?? 0);
      for (let previous = 1; previous < row; previous++) top += (groupRows.has(previous) ? 18 : cardHeight) + 16;
      height = cardHeight;
    }
    return { top, bottom: top + height, left: 0, right: 1440, width: 1440, height, x: 0, y: top, toJSON() {} };
  });
}
const largeShelf = Array.from({ length: 181 }, (_, index) => ({ ...works[index % works.length], id: `work-${index}` }));
const drawCase = (work: CollectionSummary) => <button data-collection-id={work.id}>{work.name}</button>;
function windowedShelf(perRow = 8, options: { pickedId?: string; restoredFocusId?: string; grouping?: "sort" | "year"; windowRows?: boolean; onPick?: (id: string) => void } = {}) {
  return <div className="collection-browser__list-scroll"><CollectionList items={largeShelf} windowRows={options.windowRows ?? true}
    pickedId={options.pickedId} restoredFocusId={options.restoredFocusId} view={{ layout: "shelf", perRow, grouping: options.grouping ?? "sort" }}
    label="작품" onPick={options.onPick ?? (() => undefined)} render={drawCase} /></div>;
}
it("mounts only near rows, including a viewport ahead, while retaining all shelf tracks", () => {
  shelfGeometry();
  const { container } = render(windowedShelf());
  const mounted = () => [...container.querySelectorAll<HTMLElement>("[data-collection-id]")].map(card => card.dataset.collectionId);
  expect(mounted()).toEqual(largeShelf.slice(0, 24).map(work => work.id));
  expect(container.querySelectorAll(".collection-list__cell")).toHaveLength(181);
  expect(container.querySelectorAll(".collection-list__plank")).toHaveLength(23);
  const cells = [...container.querySelectorAll<HTMLElement>(".collection-list__cell")];
  const before = cells.map(cell => [cell.style.gridRow, cell.style.height]);
  const root = container.firstElementChild as HTMLElement;
  root.scrollTop = 2000; fireEvent.scroll(root);
  expect(mounted().length).toBeLessThanOrEqual(40);
  expect(mounted()).toContain("work-48");
  expect(mounted()).not.toContain("work-0");
  expect(cells.map(cell => [cell.style.gridRow, cell.style.height])).toEqual(before);
  root.scrollTop = 0; fireEvent.scroll(root);
  expect(mounted()).toEqual(largeShelf.slice(0, 24).map(work => work.id));
});
it("mounts an arrow target before focusing it beyond the mounted rows", () => {
  shelfGeometry();
  const onPick = vi.fn();
  const { container } = render(windowedShelf(8, { onPick }));
  const lastNear = container.querySelector<HTMLElement>('[data-collection-id="work-23"]')!;
  expect(container.querySelector('[data-collection-id="work-31"]')).toBeNull();
  act(() => lastNear.focus());
  fireEvent.keyDown(lastNear, { key: "ArrowDown" });
  expect(onPick).toHaveBeenLastCalledWith("work-31");
  expect(document.activeElement).toBe(container.querySelector('[data-collection-id="work-31"]'));
  const root = container.firstElementChild as HTMLElement;
  root.scrollTop = 4000; fireEvent.scroll(root);
  expect(document.activeElement).toBe(container.querySelector('[data-collection-id="work-31"]'));
  expect(container.querySelectorAll('[data-list-index="31"]')).toHaveLength(1);
});
it("keeps picked and restored-focus rows mounted outside the viewport", () => {
  shelfGeometry();
  const { container } = render(windowedShelf(8, { pickedId: "work-160", restoredFocusId: "work-96" }));
  expect(container.querySelector('[data-collection-id="work-160"]')).not.toBeNull();
  expect(container.querySelector('[data-collection-id="work-96"]')).not.toBeNull();
  expect(container.querySelector('[data-collection-id="work-80"]')).toBeNull();
  const picked = container.querySelector('[data-collection-id="work-160"]');
  const root = container.firstElementChild as HTMLElement;
  for (const scrollTop of [6000, 0]) {
    root.scrollTop = scrollTop; fireEvent.scroll(root);
    expect(container.querySelector('[data-collection-id="work-160"]')).toBe(picked);
  }
});
it("recomputes row geometry and window membership when columns or grouping change", () => {
  shelfGeometry();
  const { container, rerender } = render(windowedShelf());
  const first = container.querySelector('[data-collection-id="work-0"]');
  const list = container.querySelector<HTMLElement>(".collection-list")!;
  const oldHeight = list.style.getPropertyValue("--case-height");
  rerender(windowedShelf(5));
  expect(list.style.getPropertyValue("--case-height")).not.toBe(oldHeight);
  expect(container.querySelectorAll(".collection-list__plank")).toHaveLength(37);
  expect(container.querySelectorAll("[data-collection-id]")).toHaveLength(15);
  expect(container.querySelector('[data-collection-id="work-0"]')).toBe(first);
  rerender(windowedShelf(5, { grouping: "year" }));
  expect(container.querySelectorAll(".collection-list__group")).toHaveLength(3);
  expect(container.querySelector('[data-collection-id="work-0"]')).toBe(first);
  expect(container.querySelectorAll("[data-collection-id]").length).toBeLessThanOrEqual(15);
});
it("keeps the tablet's default opt-out fully mounted", () => {
  shelfGeometry();
  const { container } = render(windowedShelf(8, { windowRows: false }));
  expect(container.querySelectorAll("[data-collection-id]")).toHaveLength(181);
});
it("remeasures restored scroll before the first animation-frame paint without a scroll event", () => {
  shelfGeometry();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  const { container } = render(windowedShelf(8, { restoredFocusId: "work-48" }));
  const root = container.firstElementChild as HTMLElement;
  root.scrollTop = 2000;
  act(() => { for (const callback of frames.values()) callback(16); });
  expect(root.scrollTop).toBe(2000);
  expect(container.querySelector('[data-collection-id="work-48"]')).not.toBeNull();
  expect(container.querySelector('[data-collection-id="work-40"]')).not.toBeNull();
  expect(container.querySelector('[data-collection-id="work-0"]')).toBeNull();
});


it("lays manga on the shared shelf in one group for every grouping choice", () => {
  const manga = works.map(work => ({ ...work, type: "manga" as const }));
  const draw = (grouping: "device" | "year" | "sort") => <CollectionList items={manga} view={{ layout: "shelf", perRow: 6, grouping }} label="만화" onPick={() => undefined} render={work => <button>{work.name}</button>} />;
  const { container, rerender } = render(draw("device"));
  for (const grouping of ["device", "year", "sort"] as const) {
    rerender(draw(grouping));
    expect(container.querySelector(".collection-list--shelf")).not.toBeNull();
    expect(container.querySelector(".collection-list__group")).toBeNull();
    expect(container.querySelectorAll(".collection-list__cell")).toHaveLength(24);
    expect(container.querySelectorAll(".collection-list__plank")).toHaveLength(4);
  }
});

it("windows manga shelf rows with the same tracks as the other work cases", () => {
  shelfGeometry();
  const manga = largeShelf.map(work => ({ ...work, type: "manga" as const }));
  const { container } = render(<div className="collection-browser__list-scroll"><CollectionList items={manga} windowRows
    view={{ layout: "shelf", perRow: 8, grouping: "device" }} label="만화" onPick={() => undefined} render={drawCase} /></div>);
  expect(container.querySelectorAll(".collection-list__cell")).toHaveLength(181);
  expect(container.querySelectorAll(".collection-list__plank")).toHaveLength(23);
  expect(container.querySelectorAll("[data-collection-id]")).toHaveLength(24);
  const root = container.firstElementChild as HTMLElement;
  root.scrollTop = 2000; fireEvent.scroll(root);
  expect(container.querySelector('[data-collection-id="work-0"]')).toBeNull();
  expect(container.querySelector('[data-collection-id="work-48"]')).not.toBeNull();
});

it("windows opted-in horizontal performer shelves in the tablet scroll root", () => {
  shelfGeometry();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) {
    return this.classList.contains("collection-scroll") ? 500 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const list = this.closest<HTMLElement>(".collection-list"), root = this.closest<HTMLElement>(".collection-scroll");
    const cell = this.classList.contains("collection-list__cell");
    const width = cell && list ? parseFloat(list.style.getPropertyValue("--cell-width")) : 1440;
    const height = cell && list ? parseFloat(list.style.getPropertyValue("--case-height")) + 64 : 500;
    const left = cell ? (Number(this.style.gridColumn) - 1) * (width + 16) - (list?.scrollLeft ?? 0) : 0;
    const top = cell ? 16 - (root?.scrollTop ?? 0) : 0;
    return { top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON() {} };
  });
  const { container } = render(<div className="collection-scroll"><CollectionList items={largeShelf} windowRows showcase pickedId="work-160"
    view={{ layout: "shelf", perRow: 8, grouping: "sort" }} label="배우" onPick={() => undefined} render={drawCase} /></div>);
  const list = container.querySelector<HTMLElement>(".collection-list")!, root = container.firstElementChild as HTMLElement;
  expect(container.querySelectorAll(".collection-list__cell")).toHaveLength(181);
  expect(container.querySelectorAll(".collection-list__plank")).toHaveLength(1);
  expect(container.querySelectorAll("[data-collection-id]").length).toBeLessThanOrEqual(24);
  expect(container.querySelector('[data-collection-id="work-0"]')).not.toBeNull();
  list.scrollLeft = 4000; fireEvent.scroll(list);
  expect(container.querySelector('[data-collection-id="work-0"]')).toBeNull();
  expect(container.querySelector('[data-collection-id="work-24"]')).not.toBeNull();
  expect(container.querySelector('[data-collection-id="work-160"]')).not.toBeNull();
  root.scrollTop = 2000; fireEvent.scroll(root);
  expect(container.querySelectorAll("[data-collection-id]")).toHaveLength(1);
  root.scrollTop = 0; list.scrollLeft = 0; fireEvent.scroll(root);
  expect(container.querySelector('[data-collection-id="work-0"]')).not.toBeNull();
});
