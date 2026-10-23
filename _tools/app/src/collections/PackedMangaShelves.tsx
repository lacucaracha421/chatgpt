import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { mangaShelfStyle } from "./mangaDimensions";
import { MANGA_SHELF_GUTTER, packMangaShelves, type MangaShelfRun } from "./mangaShelfLayout";
import { ShelfMaterial } from "./ShelfMaterial";
import "./mangaShelf.css";

function Shelf<W extends { id: string }>({ runs, index, ready, near, renderRun }: {
  runs: MangaShelfRun<W>[]; index: number; ready: Set<string>; near: boolean;
  renderRun(run: MangaShelfRun<W>, near: boolean): ReactNode;
}) {
  const visited = useRef(false);
  if (near) visited.current = true;
  return <div className="manga-shelf-row" role="group" aria-label={`${index + 1}번째 선반`}>
    <div className="manga-shelf-row__board"><ShelfMaterial /></div>
    <div className="manga-shelf-row__runs">
      {visited.current && runs.map(run => <div key={`${run.work.id}:${run.start}`} className="manga-shelf-row__slot" style={{ width: run.width }}>
        {ready.has(run.work.id) && renderRun(run, near)}
      </div>)}
    </div>
  </div>;
}

/** Estimated runs are addressable immediately; detail reads never depend on a completed prefix. */
export function PackedMangaShelves<W extends { id: string }>({ items, identity, label, scale, tablet = false, active = true, estimate, cachedCount, prepare, renderRun }: {
  items: W[]; identity: string; label: string; scale: number; tablet?: boolean; active?: boolean;
  estimate(work: W): number; cachedCount(work: W): number | undefined;
  prepare(work: W, signal: AbortSignal): Promise<number>;
  renderRun(run: MangaShelfRun<W>, near: boolean): ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(800);
  const initial = () => ({ identity, counts: new Map(items.flatMap(work => {
    const count = cachedCount(work);
    return count === undefined ? [] : [[work.id, count] as const];
  })) });
  const [state, setState] = useState(initial);
  if (state.identity !== identity) setState(initial());
  const rows = useMemo(() => packMangaShelves(items, work => state.counts.get(work.id) ?? estimate(work), width, scale, tablet), [items, state.counts, width, scale, tablet, estimate]);
  const ready = useMemo(() => new Set(state.counts.keys()), [state.counts]);
  const incoming = { identity, rows, ready };
  const previous = useRef(incoming);
  // Retain the old publication until an incoming work is prepared.
  const view = previous.current.identity === identity || ready.size || !items.length ? incoming : previous.current;
  const [nearRows, setNearRows] = useState<number[]>([0]);
  const distances = useRef(new Map<number, number>([[0, 0]]));
  const anchor = useRef<{ identity: string; id: string; volume: number; top: number } | null>(null);
  const measure = useRef(() => {});
  measure.current = () => {
    const element = host.current;
    if (!element) return;
    const scroller = root.current;
    const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
    const height = scroller?.clientHeight ?? window.innerHeight;
    const bottom = top + height;
    const next = new Map<number, number>();
    let measured = false;
    let firstVisible = false;
    anchor.current = null;
    Array.from(element.children).forEach((child, index) => {
      const rect = child.getBoundingClientRect();
      if (height <= 0 || rect.height <= 0) return;
      measured = true;
      const distance = rect.bottom <= top ? top - rect.bottom + 1 : rect.top >= bottom ? rect.top - bottom + 1 : 0;
      if (distance <= 600) next.set(index, distance);
      if (!firstVisible && rect.height && rect.bottom > top && rect.top < bottom) {
        firstVisible = true;
        const run = view.rows[index]?.find(run => view.ready.has(run.work.id)) ?? view.rows[index]?.[0];
        if (run) anchor.current = { identity: view.identity, id: run.work.id, volume: run.start, top: rect.top - top };
      }
    });
    // A retained empty publication has no rows to measure yet. Zero-sized layouts
    // also cannot tell us which works are near: read and reveal in list order.
    if (!measured) rows.forEach((_, index) => next.set(index, 0));
    const oldDistances = distances.current;
    distances.current = next;
    const indices = [...next.keys()];
    setNearRows(current => current.length === indices.length && current.every((value, index) => value === indices[index] && oldDistances.get(value) === next.get(value)) ? current : indices);
  };
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let scroller = element.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      if (["auto", "scroll", "overlay"].includes(style.overflowY || style.overflow)) break;
      scroller = scroller.parentElement;
    }
    root.current = scroller;
    const resize = () => {
      if (element.clientWidth) setWidth(Math.max(1, element.clientWidth - MANGA_SHELF_GUTTER * 2));
      measure.current();
    };
    const scroll = () => measure.current();
    const target = scroller ?? window;
    target.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", resize);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(element);
    if (scroller) observer?.observe(scroller);
    resize();
    return () => { target.removeEventListener("scroll", scroll); window.removeEventListener("resize", resize); observer?.disconnect(); };
  }, []);
  useLayoutEffect(() => {
    const saved = anchor.current;
    const scroller = root.current;
    if (saved?.identity === view.identity && scroller) {
      const index = view.rows.findIndex(row => row.some(run => run.work.id === saved.id && run.start <= saved.volume && run.start + run.count > saved.volume));
      const element = host.current?.children[index];
      if (element) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop - saved.top;
    }
    previous.current = view;
    measure.current();
  }, [rows, view.rows, view.identity]);

  const jobs = useRef(new Map<string, AbortController>());
  const [, wake] = useState(0);
  useEffect(() => () => { for (const controller of jobs.current.values()) controller.abort(); }, []);
  // Reconsider priority on scroll and each completion. Offscreen work is never queued
  // ahead of the viewport; started reads finish into the clients' shared caches.
  useEffect(() => {
    if (!active || state.identity !== identity) return;
    const candidates = new Map<string, { work: W; distance: number }>();
    for (const [index, distance] of distances.current) for (const run of rows[index] ?? []) {
      const hit = candidates.get(run.work.id);
      if (!hit || distance < hit.distance) candidates.set(run.work.id, { work: run.work, distance });
    }
    for (const { work } of [...candidates.values()].sort((a, b) => a.distance - b.distance)) {
      if (jobs.current.size >= 2) break;
      const key = JSON.stringify([identity, work.id]);
      if (ready.has(work.id) || jobs.current.has(key)) continue;
      const controller = new AbortController();
      jobs.current.set(key, controller);
      void prepare(work, controller.signal).catch(() => estimate(work)).then(count => {
        if (!controller.signal.aborted) setState(current => current.identity === identity ? { ...current, counts: new Map(current.counts).set(work.id, count) } : current);
      }).finally(() => { jobs.current.delete(key); wake(value => value + 1); });
    }
  });
  return <div ref={host} className="manga-shelf-list" role="group" aria-label={label} style={{ ...mangaShelfStyle(tablet), "--manga-spine-scale": scale, overflowAnchor: "none" } as CSSProperties}>
    {view.rows.map((runs, index) => <Shelf key={index} runs={runs} index={index} ready={view.ready} near={nearRows.includes(index)} renderRun={renderRun} />)}
  </div>;
}
