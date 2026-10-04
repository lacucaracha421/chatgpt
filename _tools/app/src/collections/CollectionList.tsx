import "./collectionShelfRules.css";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { CollectionSummary, CollectionType } from "../library/types";
import { casePlatform } from "./case/CollectionCase";

export type CollectionViewSettings = { layout: "grid" | "shelf" | "bookcase"; perRow: number; grouping: "device" | "year" | "sort" };
type ShelfItem = Pick<CollectionSummary, "id" | "type"> & Partial<Pick<CollectionSummary, "platforms" | "year" | "releaseDate">>;
function initialViews(): Record<CollectionType, CollectionViewSettings> {
  return Object.fromEntries((["game", "manga", "movie", "av"] as const).map(type => {
    const fallback: CollectionViewSettings = { layout: "shelf", perRow: 8, grouping: "device" };
    try {
      const value = JSON.parse(localStorage.getItem(`lakomics.collections.view.${type}.v1`) ?? "null");
      if (value) return [type, { layout: value.layout === "grid" || value.layout === "shelf" || (type === "manga" && value.layout === "bookcase") ? value.layout : fallback.layout, perRow: Number.isInteger(value.perRow) ? Math.max(5, Math.min(12, value.perRow)) : 8, grouping: ["device", "year", "sort"].includes(value.grouping) ? value.grouping : "device" }];
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
// Half a viewport keeps scrolling prepared without decoding a second screen on entry.
const SHELF_OVERSCAN_VIEWPORTS = .5;

/** Flat, keyed cells retain shelf geometry even while their cases are outside the window. */
export function CollectionList<T extends ShelfItem>({ items, view, render, label, onPick, showcase = false, windowRows = false, pickedId, restoredFocusId }: {
  items: T[]; view: CollectionViewSettings; render(item: T): ReactNode; label: string;
  onPick(id: string): void; showcase?: boolean;
  /** Opt in to vertical rows, or visible columns for a single-plank showcase. */
  windowRows?: boolean; pickedId?: string | null; restoredFocusId?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const measureWindow = useRef<(() => void) | null>(null);
  const [nearRows, setNearRows] = useState<Set<number>>(() => new Set([1, 2]));
  const [focusedId, setFocusedId] = useState<string | null>(null);
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
  const shelf = view.layout === "shelf";
  const cellWidth = Math.max(1, (metrics.width - metrics.padding - metrics.gap * (view.perRow - 1)) / view.perRow);
  // Approved shelf geometry reserves the turned cover and the 22px spine.
  const height = Math.min(300, Math.max(1, (cellWidth - 13) / (.8 * (2 / 3))));
  const perRow = view.perRow, grouping = view.grouping;
  const windowed = windowRows && shelf;
  const { groups, positions, ordered, rowStarts } = useMemo(() => {
    const groups = shelf && !showcase ? shelfGroups(items, grouping) : [{ label: "", items }];
    const ordered = groups.flatMap(group => group.items);
    const positions: { row: number; column: number }[] = [];
    const rowStarts: { row: number; index: number }[] = [];
    let row = 1;
    for (const group of groups) {
      if (group.label) row++;
      group.items.forEach((_, index) => {
        const itemRow = showcase ? row : row + Math.floor(index / perRow);
        if (index % perRow === 0 && (!showcase || index === 0)) rowStarts.push({ row: itemRow, index: positions.length });
        positions.push({ row: itemRow, column: showcase ? index : index % perRow });
      });
      row += Math.ceil(group.items.length / perRow);
    }
    return { groups, positions, ordered, rowStarts };
  }, [items, shelf, showcase, grouping, perRow]);

  useLayoutEffect(() => {
    if (!windowed) return;
    const element = ref.current;
    const root = element?.closest<HTMLElement>(".collection-browser__list-scroll, .collection-scroll");
    if (!element || !root) return;
    // Empty cell wrappers have exactly the card height. Read actual grid positions so group
    // headings, padding, resize and a folded Showcase need no estimated offsets.
    const cells = (showcase ? positions.map((_, index) => ({ row: index + 1, index })) : rowStarts).map(({ row, index }) => ({ row,
      cell: element.querySelector<HTMLElement>(`[data-list-index="${index}"]`)! }));
    let lastGeometry: number[] | null = null;
    const measure = () => {
      if (root.clientHeight <= 0) return;
      const top = root.getBoundingClientRect().top + root.clientTop;
      const bounds = element.getBoundingClientRect();
      // Cell shells have fixed track heights. Parent updates often leave all geometry unchanged;
      // avoid rereading every row then, while still noticing a moved list or restored scroll.
      const geometry = [top, root.scrollTop, root.clientHeight, bounds.top, bounds.left, bounds.width, bounds.height, element.scrollLeft];
      if (lastGeometry && geometry.every((value, index) => value === lastGeometry![index])) return;
      lastGeometry = geometry;
      const overscan = root.clientHeight * SHELF_OVERSCAN_VIEWPORTS;
      const horizontalMargin = element.clientWidth * SHELF_OVERSCAN_VIEWPORTS;
      const next = new Set(cells.filter(({ cell }) => {
        const rect = cell.getBoundingClientRect();
        const verticallyNear = rect.bottom >= top - overscan && rect.top <= top + root.clientHeight + overscan;
        if (!showcase) return verticallyNear;
        return verticallyNear && rect.right >= bounds.left - horizontalMargin && rect.left <= bounds.right + horizontalMargin;
      }).map(({ row }) => row));
      setNearRows(current => current.size === next.size && [...next].every(row => current.has(row)) ? current : next);
    };
    measureWindow.current = measure;
    // The browser restores scroll in its parent layout effect, after this first measurement.
    const frame = requestAnimationFrame(() => flushSync(measure));
    const onScroll = () => flushSync(measure);
    root.addEventListener("scroll", onScroll, { passive: true });
    if (showcase) element.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => flushSync(measure));
    observer?.observe(root); observer?.observe(element);
    return () => { measureWindow.current = null; cancelAnimationFrame(frame); root.removeEventListener("scroll", onScroll); element.removeEventListener("scroll", onScroll); observer?.disconnect(); };
  }, [windowed, rowStarts, positions, showcase, height]);
  // Also measure after parent renders that move the list without resizing it (Showcase fold).
  useLayoutEffect(() => { measureWindow.current?.(); });

  const pinnedRows = useMemo(() => new Set(windowed ? ordered.flatMap((item, index) =>
    item.id === pickedId || item.id === focusedId || item.id === restoredFocusId ? [showcase ? index + 1 : positions[index].row] : []) : []),
  [windowed, ordered, positions, showcase, pickedId, focusedId, restoredFocusId]);
  // Width-only measurements update the CSS geometry without drawing every case again.
  const children = useMemo(() => {
    const children: ReactNode[] = [];
    let row = 1, itemIndex = 0;
    for (const group of groups) {
      if (group.label) children.push(<div key={`group:${group.label}`} className="collection-list__group" style={{ gridRow: row++, gridColumn: "1 / -1" }}>{group.label}<span>{group.items.length.toLocaleString()}</span></div>);
      group.items.forEach(item => {
        const position = positions[itemIndex];
        const windowKey = showcase ? itemIndex + 1 : position.row;
        children.push(<div key={item.id} className="collection-list__cell" data-list-index={itemIndex++}
          style={{ gridRow: position.row, gridColumn: position.column + 1, height: windowed ? "calc(var(--case-height) + 64px)" : undefined }}>
          {!windowed || nearRows.has(windowKey) || pinnedRows.has(windowKey) ? render(item) : null}
        </div>);
      });
      for (let index = 0; index < (showcase ? Math.min(1, group.items.length) : Math.ceil(group.items.length / perRow)); index++) {
        children.push(<div key={`plank:${group.label}:${index}`} className="collection-list__plank" aria-hidden="true" style={{ gridRow: row + index, gridColumn: showcase ? `1 / ${Math.max(perRow, group.items.length) + 1}` : "1 / -1" }} />);
      }
      row += Math.ceil(group.items.length / perRow);
    }
    return children;
  }, [groups, positions, perRow, showcase, render, windowed, nearRows, pinnedRows]);
  return <div ref={ref} className={`collection-list collection-list--${shelf ? "shelf" : "grid"}${showcase ? " collection-list--showcase" : ""}`} role="group" aria-label={label}
    data-per-row={view.perRow} style={{ "--columns": view.perRow, "--cell-width": `${cellWidth}px`, "--case-height": `${height}px` } as CSSProperties}
    onFocusCapture={event => {
      const card = (event.target as HTMLElement).closest<HTMLElement>("[data-collection-id]");
      if (windowed && card) setFocusedId(card.dataset.collectionId ?? null);
    }}
    onBlurCapture={event => { if (windowed && !event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null); }}
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
      if (ordered[index]) {
        // Commit the target row before querying/focusing its previously unmounted button.
        if (windowed) flushSync(() => setFocusedId(ordered[index].id));
        onPick(ordered[index].id);
      }
      ref.current?.querySelector<HTMLElement>(`[data-list-index="${index}"] [data-collection-id]`)?.focus();
    }}>{children}</div>;
}
