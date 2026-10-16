import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { CASE_PLASTIC, CaseSpine, spineInsertClass, type CaseData } from "./case/CollectionCase";
import { nearestCell, packSpineShelf, type PackedCell, type PackedEntry, type PackedRow, type PackedWork, type ShelfGroup } from "./spineShelfLayout";
import "./SpineShelf.css";

/** One case on the 책장: plain data, so the PC and the tablet draw it the same way. */
export type SpineWork = PackedWork & {
  title: string; credit: string; developer: string | null;
  /** Front cover shown when the case is pulled out; spine artwork shown on the spine. */
  front: string | null; spine: string | null;
  /** The owned device or spine artwork is not read yet: the spine stays plastic only, at its final size. */
  pending: boolean;
};
/**
 * Where a client gets its image URLs. The default reads them off the work; the tablet swaps in hooks that
 * request a ticket per image. The hooks are called once per mounted spine or pulled-out cover.
 */
export type SpineArt<W extends SpineWork> = {
  useSpine(work: W, host: RefObject<Element | null>): { url: string | null; pending: boolean };
  useFront(work: W, host: RefObject<Element | null>): string | null;
};
const WORK_ART: SpineArt<SpineWork> = {
  useSpine: work => ({ url: work.spine, pending: work.pending }),
  useFront: work => work.front,
};

/** Rows within this many viewports above and below the visible part stay mounted. */
const OVERSCAN_VIEWPORTS = .5;
/** The viewport assumed until the scroll area has a measurable size. */
const FALLBACK_VIEWPORT = 900;
const ENTRANCE_MS = 800;
/** The entries (labels and rows) that overlap the visible part of the shelf plus half a viewport on each side. */
function windowRange(entries: readonly { top: number; height: number }[], top: number, height: number): [number, number] {
  const low = top - height * OVERSCAN_VIEWPORTS, high = top + height * (1 + OVERSCAN_VIEWPORTS);
  let first = -1, last = -2;
  entries.forEach((entry, index) => { if (entry.top + entry.height >= low && entry.top <= high) { if (first < 0) first = index; last = index; } });
  return first < 0 ? [0, -1] : [first, last];
}
const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** What the scrubber needs from a shelf that mounts only a window of its rows. */
export type SpineShelfControl = { seek(index: number): void; indexAtScroll(): number };

type Props<W extends SpineWork> = {
  groups: ShelfGroup<W>[];
  /** Pixels per millimetre (`SPINE_SCALE`). */
  scale: number;
  label: string;
  pickedId: string | null;
  /** The case pulled out, or null when it is put back. */
  onPick(id: string | null): void;
  onOpen(id: string): void;
  privacy?: boolean;
  /** Tablet: a tap anywhere in a row picks the nearest case, because spines are thinner than a finger. */
  touchTargets?: boolean;
  /** Space between the host edge and the first spine. */
  gutter?: number;
  restoredFocusId?: string | null;
  menu?(id: string): ContextMenuItem[];
  art?: SpineArt<W>;
  /** The works whose rows are mounted, when that set changes (a client may read their artwork lazily). */
  onWindow?(ids: string[]): void;
  /** The rows of a first appearance rise in once, staggered by row. */
  entrance?: boolean;
  controlRef?: { current: SpineShelfControl | null };
};

export function SpineShelf<W extends SpineWork>({ groups, scale, label, pickedId, onPick, onOpen, privacy = false, touchTargets = false, gutter = 24, restoredFocusId, menu, art, onWindow, entrance = false, controlRef }: Props<W>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [focusId, setFocusId] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const available = Math.max(1, width - gutter * 2);
  const packed = useMemo(() => packSpineShelf(groups, available, scale), [groups, available, scale]);
  const { entries, rows, order, cells } = packed;
  const [range, setRange] = useState<[number, number]>(() => windowRange(entries, 0, FALLBACK_VIEWPORT));
  const tabbableId = focusId && cells.has(focusId) ? focusId : order[0] ?? null;

  // The scroll area the shelf lives in; its width is the shelf's, its scroll position drives the window.
  const rootOf = useCallback(() => hostRef.current?.closest<HTMLElement>(".collection-browser__list-scroll, .collection-scroll") ?? hostRef.current?.parentElement ?? null, []);
  const windowFor = useCallback((): [number, number] => {
    const host = hostRef.current, root = rootOf();
    let top = 0, height = FALLBACK_VIEWPORT;
    if (host && root && root.clientHeight > 0) {
      const offset = host.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      top = root.scrollTop - offset; height = root.clientHeight;
    }
    return windowRange(entries, top, height);
  }, [entries, rootOf]);
  const measure = useCallback(() => {
    const host = hostRef.current;
    if (host && host.clientWidth > 0) setWidth(current => current === host.clientWidth ? current : host.clientWidth);
    const next = windowFor();
    setRange(current => current[0] === next[0] && current[1] === next[1] ? current : next);
  }, [windowFor]);
  const measureRef = useRef(measure); measureRef.current = measure;
  // A new packing (width, size, list) moves the rows: measure again before painting.
  useLayoutEffect(() => { measure(); }, [measure]);
  useLayoutEffect(() => {
    const host = hostRef.current, root = rootOf();
    if (!host) return;
    let frame = 0, settle = 0;
    const onScroll = () => {
      host.dataset.scrolling = "";
      window.clearTimeout(settle); settle = window.setTimeout(() => { delete host.dataset.scrolling; }, 150);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measureRef.current(); });
    };
    root?.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measureRef.current());
    observer?.observe(host); if (root) observer?.observe(root);
    return () => { root?.removeEventListener("scroll", onScroll); observer?.disconnect(); cancelAnimationFrame(frame); window.clearTimeout(settle); };
  }, [rootOf]);

  useEffect(() => {
    if (!controlRef) return;
    const offsetOf = () => { const host = hostRef.current, root = rootOf(); return host && root ? host.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop : 0; };
    controlRef.current = {
      seek(index) {
        const root = rootOf(), id = order[Math.max(0, Math.min(order.length - 1, index))], cell = id ? cells.get(id) : undefined;
        if (root && cell) root.scrollTop = offsetOf() + rows[cell.row].top;
      },
      indexAtScroll() {
        const root = rootOf(); if (!root || !rows.length) return 0;
        const top = root.scrollTop - offsetOf();
        const row = rows.find(item => item.top + item.height > top + 1) ?? rows[rows.length - 1];
        return Math.max(0, order.indexOf(row.cells[0].work.id));
      },
    };
    return () => { controlRef.current = null; };
  });

  // Rows that stay mounted outside the window: the picked case, the tab stop and the one focus returns to.
  const pinned = useMemo(() => {
    const set = new Set<number>();
    for (const id of [pickedId, tabbableId, restoredFocusId]) { const cell = id ? cells.get(id) : undefined; if (cell) set.add(cell.row); }
    return set;
  }, [pickedId, tabbableId, restoredFocusId, cells]);
  const mounted = useMemo(() => {
    const shown: PackedEntry<W>[] = [];
    entries.forEach((entry, index) => { if ((index >= range[0] && index <= range[1]) || (entry.kind === "row" && pinned.has(entry.index))) shown.push(entry); });
    return shown;
  }, [entries, range, pinned]);

  const windowIds = useMemo(() => mounted.flatMap(entry => entry.kind === "row" ? entry.cells.map(cell => cell.work.id) : []), [mounted]);
  const windowSignature = windowIds.length ? `${windowIds[0]}:${windowIds.length}:${windowIds[windowIds.length - 1]}` : "";
  const onWindowRef = useRef(onWindow); onWindowRef.current = onWindow;
  useEffect(() => { if (windowIds.length) onWindowRef.current?.(windowIds); }, [windowSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // First appearance: the rows mounted by the first render rise in once; rows scrolled in later do not.
  const entering = useRef<Map<number, number> | null>(null);
  if (entering.current === null) {
    entering.current = new Map();
    if (entrance && !reducedMotion()) mounted.forEach(entry => { if (entry.kind === "row" && entering.current!.size < 18) entering.current!.set(entry.index, entering.current!.size); });
  }
  useEffect(() => { const timer = window.setTimeout(() => entering.current?.clear(), ENTRANCE_MS); return () => window.clearTimeout(timer); }, []);

  // Put-down: the pulled-out cover of the previous pick turns back into its spine before it goes.
  const [leaving, setLeaving] = useState<string | null>(null);
  const previousPick = useRef<string | null>(pickedId);
  useEffect(() => {
    const before = previousPick.current; previousPick.current = pickedId;
    if (!before || before === pickedId || reducedMotion()) { setLeaving(null); return; }
    setLeaving(before);
    const timer = window.setTimeout(() => setLeaving(current => current === before ? null : current), 380);
    return () => window.clearTimeout(timer);
  }, [pickedId]);

  // A returning visit puts the remembered case back out (the browser restores scroll and focus).
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!restoredFocusId || restored.current === restoredFocusId || !cells.has(restoredFocusId)) return;
    restored.current = restoredFocusId; setFocusId(restoredFocusId); onPick(restoredFocusId);
  }, [restoredFocusId, cells, onPick]);

  useLayoutEffect(() => {
    const id = pendingFocus.current; if (!id) return;
    const button = [...hostRef.current?.querySelectorAll<HTMLElement>(".spine") ?? []].find(spine => spine.dataset.collectionId === id);
    if (button) { pendingFocus.current = null; button.focus({ preventScroll: true }); }
  });

  /** Scrolls the row of `id` into view and focuses its spine once that row is mounted. */
  const moveTo = (id: string, pick: boolean) => {
    const cell = cells.get(id), host = hostRef.current, root = rootOf();
    if (!cell) return;
    const row = rows[cell.row];
    if (host && root) {
      const offset = host.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      if (offset + row.top < root.scrollTop) root.scrollTop = offset + row.top - 8;
      else if (offset + row.top + row.height > root.scrollTop + root.clientHeight && root.clientHeight > 0) root.scrollTop = offset + row.top + row.height - root.clientHeight + 8;
    }
    pendingFocus.current = id; setFocusId(id);
    if (pick) onPick(id);
  };
  const activate = (id: string) => {
    if (pickedId === id) { onOpen(id); return; }
    setFocusId(id); onPick(id);
  };
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const out = target.closest<HTMLElement>(".spine-shelf__out");
    if (out) { onOpen(out.dataset.id!); return; }
    const spine = target.closest<HTMLElement>(".spine");
    if (spine) { activate(spine.dataset.collectionId!); return; }
    const rowElement = touchTargets ? target.closest<HTMLElement>("[data-shelf-row]") : null;
    if (rowElement) {
      const nearest = nearestCell(rows[Number(rowElement.dataset.shelfRow)], event.clientX - rowElement.getBoundingClientRect().left);
      if (nearest) {
        // The scroller's put-down must not undo this pick.
        event.stopPropagation(); activate(nearest.work.id); return;
      }
    }
    onPick(null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const holder = (event.target as HTMLElement).closest<HTMLElement>(".spine, .spine-shelf__out");
    if (!holder) return;
    const id = holder.dataset.collectionId ?? holder.dataset.id!, cell = cells.get(id);
    if (!cell) return;
    const index = order.indexOf(id), row = rows[cell.row];
    let next: string | undefined;
    switch (event.key) {
      case "ArrowRight": next = order[Math.min(order.length - 1, index + 1)]; break;
      case "ArrowLeft": next = order[Math.max(0, index - 1)]; break;
      case "ArrowDown": next = nearestCell(rows[cell.row + 1], cell.x + cell.width / 2)?.work.id ?? id; break;
      case "ArrowUp": next = nearestCell(rows[cell.row - 1], cell.x + cell.width / 2)?.work.id ?? id; break;
      case "Home": next = row.cells[0].work.id; break;
      case "End": next = row.cells[row.cells.length - 1].work.id; break;
      case "Enter": event.preventDefault(); if (pickedId === id) onOpen(id); else { setFocusId(id); onPick(id); } return;
      case " ": event.preventDefault(); if (pickedId === id) onPick(null); else { setFocusId(id); onPick(id); } return;
      case "Escape": if (pickedId) { event.preventDefault(); event.stopPropagation(); onPick(null); } return;
      default: return;
    }
    event.preventDefault();
    if (next) moveTo(next, true);
  };

  const entranceOf = (row: PackedRow<W>) => entering.current?.get(row.index);
  return <div ref={hostRef} className="spine-shelf" role="group" aria-label={label}
    style={{ height: packed.height, "--spine-scale": scale, "--spine-gutter": `${gutter}px` } as CSSProperties}
    onClick={onClick} onKeyDown={onKeyDown}
    onFocus={event => { const spine = (event.target as HTMLElement).closest<HTMLElement>(".spine"); if (spine?.dataset.collectionId) setFocusId(spine.dataset.collectionId); }}>
    {mounted.map(entry => entry.kind === "label"
      ? <div key={`label:${entry.top}`} className="spine-shelf__label" style={{ top: entry.top, height: entry.height }}><SectionLabel title={entry.label} count={entry.count} /></div>
      : <ShelfRow<W> key={`row:${entry.index}`} row={entry} available={available} picked={entry.cells.some(cell => cell.work.id === pickedId) ? pickedId : null}
        leaving={leaving && entry.cells.some(cell => cell.work.id === leaving) ? leaving : null}
        tabbable={entry.cells.some(cell => cell.work.id === tabbableId) ? tabbableId : null} privacy={privacy} menu={menu} art={(art ?? WORK_ART) as SpineArt<W>} entering={entranceOf(entry)} />)}
  </div>;
}

type RowProps<W extends SpineWork> = {
  row: PackedRow<W>; available: number; picked: string | null; leaving: string | null; tabbable: string | null; privacy: boolean;
  menu?(id: string): ContextMenuItem[]; art: SpineArt<W>; entering?: number;
};
function ShelfRowView<W extends SpineWork>({ row, available, picked, leaving, tabbable, privacy, menu, art, entering }: RowProps<W>) {
  const board = useRef<HTMLDivElement>(null);
  const outs = [picked, leaving].filter((id, index, list): id is string => Boolean(id) && list.indexOf(id) === index);
  return <div className={`spine-shelf__row${entering !== undefined ? " is-entering" : ""}`} data-shelf-row={row.index}
    style={{ top: row.top, height: row.height, "--board-height": `${row.board}px`, ...(entering !== undefined ? { "--i": entering } : {}) } as CSSProperties}>
    <div ref={board} className="spine-shelf__board">
      <div className="spine-shelf__spines">
        {row.cells.map(cell => <Spine<W> key={cell.work.id} cell={cell} picked={picked === cell.work.id} tabbable={tabbable === cell.work.id} privacy={privacy} menu={menu} art={art} />)}
      </div>
      {outs.map(id => {
        const cell = row.cells.find(item => item.work.id === id)!;
        return <PulledOut<W> key={id} cell={cell} available={available} leaving={id !== picked} privacy={privacy} art={art} />;
      })}
    </div>
  </div>;
}
const ShelfRow = memo(ShelfRowView) as typeof ShelfRowView;

function SpineView<W extends SpineWork>({ cell, picked, tabbable, privacy, menu, art }: { cell: PackedCell<W>; picked: boolean; tabbable: boolean; privacy: boolean; menu?(id: string): ContextMenuItem[]; art: SpineArt<W> }) {
  const { work } = cell;
  const host = useRef<HTMLButtonElement>(null);
  const { url, pending } = art.useSpine(work, host);
  const button = <button ref={host} type="button" className="spine" data-collection-id={work.id} tabIndex={tabbable ? 0 : -1}
    aria-label={work.credit ? `${work.title} · ${work.credit}` : work.title} aria-pressed={picked}
    style={{ "--w": `${cell.width}px`, "--h": `${cell.height}px`, "--plastic": CASE_PLASTIC[work.platform] } as CSSProperties}>
    <span className="spine__case">{(privacy || !pending) && <SpineArtView key={url ?? "template"} work={work} url={url} privacy={privacy} />}</span>
  </button>;
  return menu ? <ContextMenu items={menu(work.id)}>{button}</ContextMenu> : button;
}
const Spine = memo(SpineView) as typeof SpineView;

/** The printed insert. Artwork fades in over the plastic once it is decoded; a template appears in one step. */
function SpineArtView({ work, url, privacy }: { work: SpineWork; url: string | null; privacy: boolean }) {
  const [settled, setSettled] = useState(!url || privacy);
  const data: CaseData = { title: work.title, platform: work.platform, developer: work.developer, front: null, spine: url, privacy };
  const settle = useCallback(() => setSettled(true), []);
  return <span className={spineInsertClass(data)} data-settled={settled}>
    <CaseSpine decorative data={data} onSettled={settle} />
  </span>;
}

function PulledOutView<W extends SpineWork>({ cell, available, leaving, privacy, art }: { cell: PackedCell<W>; available: number; leaving: boolean; privacy: boolean; art: SpineArt<W> }) {
  const host = useRef<HTMLButtonElement>(null);
  const front = art.useFront(cell.work, host);
  const center = cell.x + cell.width / 2;
  const left = Math.max(0, Math.min(available - cell.coverWidth, center - cell.coverWidth / 2));
  const from = `translateX(${center - (left + cell.coverWidth / 2)}px) scaleX(${cell.width / cell.coverWidth})`;
  return <button ref={host} type="button" className={`spine-shelf__out${leaving ? " is-leaving" : ""}`} data-id={cell.work.id} tabIndex={-1} aria-label={`${cell.work.title} 열기`}
    style={{ left, "--cover-w": `${cell.coverWidth}px`, "--h": `${cell.height}px`, "--plastic": CASE_PLASTIC[cell.work.platform], "--from": from } as CSSProperties}>
    <span className="spine-shelf__face">
      {privacy ? <span className="case-mask" /> : front && <img src={front} alt="" decoding="async" draggable={false} onError={event => { event.currentTarget.style.visibility = "hidden"; }} />}
    </span>
  </button>;
}
const PulledOut = memo(PulledOutView) as typeof PulledOutView;
