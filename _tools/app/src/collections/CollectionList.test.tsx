import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { CollectionSummary, CollectionType } from "../library/types";
import { CollectionList, shelfGroups, useCollectionView } from "./CollectionList";

const works = Array.from({ length: 24 }, (_, index) => ({ id: `work-${index}`, name: `작품 ${index}`, type: "game", platforms: "Switch 2", year: 2026 - Math.floor(index / 8) })) as CollectionSummary[];
afterEach(() => { cleanup(); localStorage.clear(); });
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
