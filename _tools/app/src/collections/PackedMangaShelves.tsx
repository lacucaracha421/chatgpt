import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { mangaShelfStyle, MANGA_MM, MANGA_PX_PER_MM } from "./mangaDimensions";
import { MANGA_SHELF_GUTTER, packMangaShelves, type MangaShelfRun } from "./mangaShelfLayout";
import { ShelfMaterial } from "./ShelfMaterial";
import "./mangaShelf.css";
import { MangaBitmapScale } from "./work/MangaSpineBitmap";
import { noteMangaShelfScroll } from "./work/mangaSpineBitmaps";

const Shelf = memo(function Shelf<W extends { id: string }>({ runs, index, ready, near, renderRun }: {
  runs: MangaShelfRun<W>[]; index: number; ready: Set<string>; near: boolean;
  renderRun(run: MangaShelfRun<W>, near: boolean): ReactNode;
}) {
  return <div className="manga-shelf-row" data-mounted={near || undefined} role="group" aria-label={`${index + 1}번째 선반`}>
    <div className="manga-shelf-row__board"><ShelfMaterial /></div>
    <div className="manga-shelf-row__runs">
      {near && runs.map(run => <div key={`${run.work.id}:${run.start}`} className="manga-shelf-row__slot" style={{ width: run.width }}>
        {ready.has(run.work.id) && renderRun(run, true)}
      </div>)}
    </div>
  </div>;
}) as <W extends { id: string }>(props: {
  runs: MangaShelfRun<W>[]; index: number; ready: Set<string>; near: boolean;
  renderRun(run: MangaShelfRun<W>, near: boolean): ReactNode;
}) => ReactNode;

type RowWindow = { start: number; end: number; first: number; last: number };
const initialWindow: RowWindow = { start: 0, end: 0, first: 0, last: 0 };

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
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const bitmapScale = useMemo(() => ({ scale, dpr }), [scale, dpr]);
  const initial = () => {
    const counts = new Map(items.flatMap(work => {
      const count = cachedCount(work);
      return count === undefined ? [] : [[work.id, count] as const];
    }));
    return { identity, counts, packingVersion: 0 };
  };
  const [state, setState] = useState(initial);
  if (state.identity !== identity) setState(initial());
  // Readiness and geometry are separate: an accurate estimate never causes a re-pack.
  const countsForPacking = useRef(state.counts);
  countsForPacking.current = state.counts;
  const rows = useMemo(() => packMangaShelves(items, work => countsForPacking.current.get(work.id) ?? estimate(work), width, scale, tablet), [items, identity, state.packingVersion, width, scale, tablet, estimate]);
  const ready = useMemo(() => new Set(state.counts.keys()), [state.counts]);
  const incoming = { identity, rows, ready };
  const previous = useRef(incoming);
  const view = previous.current.identity === identity || ready.size || !items.length ? incoming : previous.current;
  const [rowWindow, setRowWindow] = useState(initialWindow);
  const currentWindow = useRef(initialWindow);
  const geometry = useRef({ top: 0, height: 0, step: 1 });
  const anchor = useRef<{ identity: string; id: string; volume: number; top: number } | null>(null);
  const measure = useRef(() => {});
  measure.current = () => {
    const { top, height, step } = geometry.current;
    const offset = (root.current?.scrollTop ?? window.scrollY) - top;
    const limit = Math.max(0, view.rows.length - 1);
    const clamp = (value: number) => Math.max(0, Math.min(limit, value));
    const first = clamp(Math.floor(offset / step));
    const last = clamp(Math.ceil((offset + height) / step) - 1);
    const overscan = height * 2;
    const next = { first, last, start: clamp(Math.floor((offset - overscan) / step)), end: clamp(Math.ceil((offset + height + overscan) / step) - 1) };
    const run = view.rows[first]?.find(run => view.ready.has(run.work.id)) ?? view.rows[first]?.[0];
    anchor.current = run ? { identity: view.identity, id: run.work.id, volume: run.start, top: first * step - offset } : null;
    const old = currentWindow.current;
    if (old.start !== next.start || old.end !== next.end || old.first !== next.first || old.last !== next.last) {
      currentWindow.current = next;
      setRowWindow(next);
    }
  };
  const resize = useRef(() => {});
  resize.current = () => {
    const element = host.current;
    if (!element) return;
    const scroller = root.current;
    const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
    const padding = parseFloat(getComputedStyle(element).paddingTop) || 0;
    geometry.current = {
      top: element.getBoundingClientRect().top - top + (scroller?.scrollTop ?? window.scrollY) + padding,
      height: scroller?.clientHeight || window.innerHeight,
      step: element.firstElementChild?.getBoundingClientRect().height || MANGA_MM.height * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"] * scale + 72,
    };
    setDpr(current => current === (window.devicePixelRatio || 1) ? current : window.devicePixelRatio || 1);
    if (element.clientWidth) setWidth(Math.max(1, element.clientWidth - MANGA_SHELF_GUTTER * 2));
    measure.current();
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
    let frame: number | null = null;
    const scroll = () => {
      noteMangaShelfScroll();
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; measure.current(); });
    };
    const onResize = () => resize.current();
    const target = scroller ?? window;
    target.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", onResize);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(element);
    if (scroller) observer?.observe(scroller);
    onResize();
    return () => {
      target.removeEventListener("scroll", scroll); window.removeEventListener("resize", onResize); observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  useLayoutEffect(() => {
    const changed = previous.current.rows !== view.rows || previous.current.identity !== view.identity;
    const saved = anchor.current;
    const scroller = root.current;
    // Only changed packing can move an anchor. Window/readiness updates cannot compensate scroll.
    if (changed) {
      resize.current();
      if (saved?.identity === view.identity) {
        const index = view.rows.findIndex(row => row.some(run => run.work.id === saved.id && run.start <= saved.volume && run.start + run.count > saved.volume));
        if (index >= 0) {
          const delta = index * geometry.current.step - ((scroller?.scrollTop ?? window.scrollY) - geometry.current.top) - saved.top;
          if (delta) {
            if (scroller) scroller.scrollTop += delta;
            else window.scrollBy(0, delta);
          }
        }
      }
      measure.current();
    }
    previous.current = view;
  });

  // Publish at most one heavy row per frame, including newly prepared runs.
  // Keep published rows through a wider exit band so reversing a wheel gesture reuses DOM.
  type Publication = { runs: MangaShelfRun<W>[]; ready: Set<string> };
  const [published, setPublished] = useState(() => new Map<number, Publication>(
    view.rows[0] ? [[0, { runs: view.rows[0], ready: view.ready }]] : [],
  ));
  const publication = useRef(published);
  const mountFrame = useRef<number | null>(null);
  const publish = useRef(() => {});
  publish.current = () => {
    const { top, height, step } = geometry.current;
    const offset = (root.current?.scrollTop ?? window.scrollY) - top;
    const keepStart = Math.floor((offset - height * 3) / step);
    const keepEnd = Math.ceil((offset + height * 4) / step) - 1;
    const next = new Map(publication.current);
    let changed = false;
    for (const [index, row] of next) {
      if (index < keepStart || index > keepEnd || !view.rows[index]) {
        next.delete(index); changed = true;
      } else if (row.runs !== view.rows[index]) {
        // Repacking/size changes reconcile existing runs rather than tearing down their books.
        next.set(index, { ...row, runs: view.rows[index] }); changed = true;
      }
    }
    const wanted = currentWindow.current;
    const candidates: number[] = [];
    for (let index = wanted.start; index <= wanted.end; index++) {
      const runs = view.rows[index];
      if (!runs?.some(run => view.ready.has(run.work.id))) continue;
      const old = next.get(index);
      if (!old || runs.some(run => old.ready.has(run.work.id) !== view.ready.has(run.work.id))) candidates.push(index);
    }
    candidates.sort((a, b) => Math.max(wanted.first - a, a - wanted.last, 0) - Math.max(wanted.first - b, b - wanted.last, 0));
    const index = candidates[0];
    if (index !== undefined) {
      next.set(index, { runs: view.rows[index], ready: view.ready }); changed = true;
    }
    if (changed) { publication.current = next; setPublished(next); }
    if (candidates.length > 1) mountFrame.current = requestAnimationFrame(() => { mountFrame.current = null; publish.current(); });
  };
  useLayoutEffect(() => {
    if (mountFrame.current === null) mountFrame.current = requestAnimationFrame(() => { mountFrame.current = null; publish.current(); });
  }, [rowWindow, view.rows, view.ready]);
  useEffect(() => () => {
    if (mountFrame.current !== null) cancelAnimationFrame(mountFrame.current);
    mountFrame.current = null;
  }, []);

  const jobs = useRef(new Map<string, AbortController>());
  const latestEstimate = useRef(estimate);
  latestEstimate.current = estimate;
  const completed = useRef<{ key: string; identity: string; work: W; count: number }[]>([]);
  const completionFrame = useRef<number | null>(null);
  const [completion, wake] = useState(0);
  useEffect(() => () => {
    for (const controller of jobs.current.values()) controller.abort();
    jobs.current.clear();
    completed.current = [];
    if (completionFrame.current !== null) cancelAnimationFrame(completionFrame.current);
    completionFrame.current = null;
  }, []);
  // Priority changes only at row boundaries or after a read/packing change.
  useEffect(() => {
    if (!active || state.identity !== identity) return;
    const candidates = new Map<string, { work: W; distance: number }>();
    // A retained publication can be much longer than the incoming filtered list.
    const limit = Math.max(0, rows.length - 1);
    const first = Math.min(limit, rowWindow.first), last = Math.min(limit, rowWindow.last);
    for (let index = Math.min(limit, rowWindow.start); index <= Math.min(limit, rowWindow.end); index++) {
      const distance = Math.max(first - index, index - last, 0);
      for (const run of rows[index] ?? []) {
        const hit = candidates.get(run.work.id);
        if (!hit || distance < hit.distance) candidates.set(run.work.id, { work: run.work, distance });
      }
    }
    for (const { work } of [...candidates.values()].sort((a, b) => a.distance - b.distance)) {
      if (jobs.current.size >= 2) break;
      const key = JSON.stringify([identity, work.id]);
      if (ready.has(work.id) || jobs.current.has(key)) continue;
      const controller = new AbortController();
      jobs.current.set(key, controller);
      void prepare(work, controller.signal).catch(() => estimate(work)).then(count => {
        if (!controller.signal.aborted) completed.current.push({ key, identity, work, count });
      }).finally(() => {
        if (controller.signal.aborted) {
          if (jobs.current.get(key) === controller) jobs.current.delete(key);
          return;
        }
        if (completionFrame.current !== null) return;
        completionFrame.current = requestAnimationFrame(() => {
          completionFrame.current = null;
          // Capture the latest scroll position before publishing changed geometry.
          measure.current();
          const arrivals = completed.current.splice(0);
          for (const arrival of arrivals) jobs.current.delete(arrival.key);
          setState(current => {
            const matching = arrivals.filter(arrival => arrival.identity === current.identity);
            if (!matching.length) return current;
            const counts = new Map(current.counts);
            let changedPacking = false;
            for (const arrival of matching) {
              if (Math.max(1, counts.get(arrival.work.id) ?? latestEstimate.current(arrival.work)) !== Math.max(1, arrival.count)) changedPacking = true;
              counts.set(arrival.work.id, arrival.count);
            }
            return { ...current, counts, packingVersion: current.packingVersion + Number(changedPacking) };
          });
          wake(value => value + 1);
        });
      });
    }
  }, [active, state, identity, rowWindow, rows, ready, prepare, estimate, completion]);
  return <MangaBitmapScale.Provider value={bitmapScale}><div ref={host} className="manga-shelf-list" role="group" aria-label={label} style={{ ...mangaShelfStyle(tablet), "--manga-spine-scale": scale, overflowAnchor: "none" } as CSSProperties}>
    {view.rows.map((runs, index) => <Shelf key={index} runs={runs} index={index} ready={published.get(index)?.ready ?? view.ready} near={published.has(index)} renderRun={renderRun} />)}
  </div></MangaBitmapScale.Provider>;
}
