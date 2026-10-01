import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CollectionSummary, CollectionType } from "../library/types";
import { casePlatform } from "./case/CollectionCase";

export type CollectionViewSettings = { layout: "grid" | "shelf"; perRow: number; grouping: "device" | "year" | "sort" };
type ShelfItem = Pick<CollectionSummary, "id" | "type"> & Partial<Pick<CollectionSummary, "platforms" | "year" | "releaseDate">>;
function initialViews(): Record<CollectionType, CollectionViewSettings> {
  return Object.fromEntries((["game", "manga", "movie", "av"] as const).map(type => {
    const fallback: CollectionViewSettings = { layout: "shelf", perRow: 8, grouping: "device" };
    try {
      const value = JSON.parse(localStorage.getItem(`lakomics.collections.view.${type}.v1`) ?? "null");
      if (value) return [type, { layout: value.layout === "grid" || value.layout === "shelf" ? value.layout : fallback.layout, perRow: Number.isInteger(value.perRow) ? Math.max(5, Math.min(12, value.perRow)) : 8, grouping: ["device", "year", "sort"].includes(value.grouping) ? value.grouping : "device" }];
    } catch { /* Use the approved start state when storage is unavailable. */ }
    return [type, fallback];
  })) as Record<CollectionType, CollectionViewSettings>;
}
export function useCollectionView(type: CollectionType) {
  const [views, setViews] = useState(initialViews);
  function update(patch: Partial<CollectionViewSettings>) {
    const next = { ...views[type], ...patch };
    try { localStorage.setItem(`lakomics.collections.view.${type}.v1`, JSON.stringify(next)); } catch { /* The current session keeps the view. */ }
    setViews(current => ({ ...current, [type]: next }));
  }
  return [views[type], update] as const;
}
export function shelfGroups<T extends ShelfItem>(items: T[], grouping: CollectionViewSettings["grouping"]): { label: string; items: T[] }[] {
  if (items[0]?.type !== "game" || grouping === "sort") return [{ label: "", items }];
  if (grouping === "device") {
    const nintendo = (item: T) => ["sw", "sw2"].includes(casePlatform(item.platforms ?? null)) || /nintendo|닌텐도|wii|gamecube/i.test(item.platforms ?? "");
    return [{ label: "닌텐도", items: items.filter(nintendo) }, { label: "PS · Xbox · PC", items: items.filter(item => !nintendo(item)) }].filter(group => group.items.length);
  }
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = item.releaseDate?.slice(0, 4) ?? (item.year ? String(item.year) : "발매일 없음");
    const group = groups.get(label) ?? []; group.push(item); groups.set(label, group);
  }
  return [...groups].map(([label, works]) => ({ label, items: works }));
}
/** Flat, keyed cells keep their media mounted when columns or the layout change. */
export function CollectionList<T extends ShelfItem>({ items, view, render, label, onPick, showcase = false }: {
  items: T[]; view: CollectionViewSettings; render(item: T): ReactNode; label: string;
  onPick(id: string): void; showcase?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ width: 960, gap: 16, padding: 48 });
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const measure = () => {
      if (element.clientWidth <= 0) return;
      const style = getComputedStyle(element);
      const next = { width: element.clientWidth, gap: Number.parseFloat(style.columnGap) || 16,
        padding: (Number.parseFloat(style.paddingLeft) || 24) + (Number.parseFloat(style.paddingRight) || 24) };
      setMetrics(current => current.width === next.width && current.gap === next.gap && current.padding === next.padding ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element); return () => observer?.disconnect();
  }, []);
  const shelf = view.layout === "shelf" && items[0]?.type !== "manga";
  const cellWidth = Math.max(1, (metrics.width - metrics.padding - metrics.gap * (view.perRow - 1)) / view.perRow);
  // Approved shelf geometry reserves the turned cover and the 22px spine.
  const height = Math.min(300, Math.max(1, (cellWidth - 13) / (.8 * (2 / 3))));
  const perRow = view.perRow, grouping = view.grouping;
  // The cells depend on the items, the columns and the card renderer only: a re-measure (the list's
  // width) changes the container's custom properties without re-rendering every card.
  const { children, positions, ordered } = useMemo(() => {
    const groups = shelf && !showcase ? shelfGroups(items, grouping) : [{ label: "", items }];
    const ordered = groups.flatMap(group => group.items);
    const children: ReactNode[] = [];
    const positions: { row: number; column: number }[] = [];
    let row = 1;
    for (const group of groups) {
      if (group.label) children.push(<div key={`group:${group.label}`} className="collection-list__group" style={{ gridRow: row++, gridColumn: "1 / -1" }}>{group.label}<span>{group.items.length.toLocaleString()}</span></div>);
      group.items.forEach((item, index) => {
        const itemIndex = positions.length;
        positions.push({ row: showcase ? row : row + Math.floor(index / perRow), column: showcase ? index : index % perRow });
        children.push(<div key={item.id} className={`collection-list__cell${index % perRow >= perRow - 2 ? " is-end" : ""}`} data-list-index={itemIndex} style={{ gridRow: showcase ? row : row + Math.floor(index / perRow), gridColumn: showcase ? index + 1 : index % perRow + 1 }}>{render(item)}</div>);
      });
      for (let index = 0; index < (showcase ? Math.min(1, group.items.length) : Math.ceil(group.items.length / perRow)); index++) {
        children.push(<div key={`plank:${group.label}:${index}`} className="collection-list__plank" aria-hidden="true" style={{ gridRow: row + index, gridColumn: showcase ? `1 / ${Math.max(perRow, group.items.length) + 1}` : "1 / -1" }} />);
      }
      row += Math.ceil(group.items.length / perRow);
    }
    return { children, positions, ordered };
  }, [items, shelf, showcase, grouping, perRow, render]);
  return <div ref={ref} className={`collection-list collection-list--${shelf ? "shelf" : "grid"}${showcase ? " collection-list--showcase" : ""}`} role="group" aria-label={label}
    data-per-row={view.perRow} style={{ "--columns": view.perRow, "--cell-width": `${cellWidth}px`, "--case-height": `${height}px` } as CSSProperties}
    onKeyDown={event => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-list-index]"); if (!cell || event.altKey || event.metaKey || event.ctrlKey) return;
      let index = Number(cell.dataset.listIndex);
      if (event.key === "ArrowRight") index++; else if (event.key === "ArrowLeft") index--;
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const current = positions[index], direction = event.key === "ArrowDown" ? 1 : -1;
        const nextRows = positions.filter(position => (position.row - current.row) * direction > 0).map(position => position.row);
        const nextRow = direction === 1 ? Math.min(...nextRows) : Math.max(...nextRows);
        let distance = Infinity;
        positions.forEach((position, candidate) => {
          if (position.row === nextRow && Math.abs(position.column - current.column) < distance) { distance = Math.abs(position.column - current.column); index = candidate; }
        });
      } else return;
      event.preventDefault(); index = Math.max(0, Math.min(ordered.length - 1, index));
      if (ordered[index]) onPick(ordered[index].id);
      ref.current?.querySelector<HTMLElement>(`[data-list-index="${index}"] [data-collection-id]`)?.focus();
    }}>{children}</div>;
}
