import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { useLongPress } from "../shared/useLongPress";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { CASE_PLASTIC, CaseSpine, spineInsertClass, type CaseData } from "./case/CollectionCase";
import { nearestCell, packSpineShelf, type PackedCell, type PackedEntry, type PackedRow, type PackedWork, type ShelfGroup } from "./spineShelfLayout";
import { isSpineWarm } from "./spineShelfWarm";
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
/** The works within this many viewports are reported to `onWindow`, so a client can read their artwork before the rows mount. */
const AHEAD_VIEWPORTS = 1.5;
/** How long a changed list waits, showing the old shelf, for the first screen of the new one to be ready. */
const CHANGE_HOLD_MS = 700;
/** The same wait on the first appearance, when there is no old shelf to keep: shorter, so the blank stays brief. */
const FIRST_HOLD_MS = 350;
/** The viewport assumed until the scroll area has a measurable size. */
const FALLBACK_VIEWPORT = 900;
const ENTRANCE_MS = 800;
/** The entries (labels and rows) that overlap the visible part of the shelf plus `overscan` viewports on each side. */
function windowRange(entries: readonly { top: number; height: number }[], top: number, height: number, overscan = OVERSCAN_VIEWPORTS): [number, number] {
  const low = top - height * overscan, high = top + height * (1 + overscan);
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
  /** Tablet: a long press on a work (or, with `touchTargets`, the nearest one in the row) asks for its action sheet. */
  onLongPress?(id: string): void;
  art?: SpineArt<W>;
  /** The works near the viewport (the mounted rows and the ones just beyond), when that set changes: a client may read their artwork lazily. */
  onWindow?(ids: string[]): void;
  /**
   * Set when a client reads artwork lazily. When the list changes (another sort, filter or scope) the shelf keeps
   * showing the old one until this resolves for the new first screen: `ids` are the works of the rows that will be
   * mounted, `visible` those on screen. The wait is bounded; after it the new list is shown whatever has arrived.
   * Aborted when the list changes again before it resolved. Returning nothing means it is ready already: the new
   * list replaces the old one before the next paint.
   */
  prepare?(ids: string[], visible: string[], signal: AbortSignal): Promise<void> | void;
  /** The rows of a first appearance rise in once, staggered by row. */
  entrance?: boolean;
  controlRef?: { current: SpineShelfControl | null };
};

export function SpineShelf<W extends SpineWork>({ groups, scale, label, pickedId, onPick, onOpen, privacy = false, touchTargets = false, gutter = 24, restoredFocusId, menu, onLongPress, art, onWindow, entrance = false, controlRef, prepare }: Props<W>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [focusId, setFocusId] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const available = Math.max(1, width - gutter * 2);

  // A changed list (not its artwork arriving) waits for its first screen while the old shelf stays up.
  const key = useMemo(() => groups.map(group => `${group.label}\u0001${group.works.map(item => item.id).join(",")}`).join("\u0002"), [groups]);
  const held = Boolean(prepare);
  const [shownKey, setShownKey] = useState<string | null>(() => prepare ? null : key);
  const lastGroups = useRef<ShelfGroup<W>[]>(prepare ? [] : groups);
  const live = !held || shownKey === key;
  if (live) lastGroups.current = groups;
  const shownGroups = live ? groups : lastGroups.current;
  const packed = useMemo(() => packSpineShelf(shownGroups, available, scale), [shownGroups, available, scale]);
  const { entries, rows, order, cells } = packed;
  const [range, setRange] = useState<[number, number]>(() => windowRange(entries, 0, FALLBACK_VIEWPORT));
  const [ahead, setAhead] = useState<[number, number]>(() => windowRange(entries, 0, FALLBACK_VIEWPORT, AHEAD_VIEWPORTS));
  const tabbableId = focusId && cells.has(focusId) ? focusId : order[0] ?? null;

  // The scroll area the shelf lives in; its width is the shelf's, its scroll position drives the window.
  const rootOf = useCallback(() => hostRef.current?.closest<HTMLElement>(".collection-browser__list-scroll, .collection-scroll") ?? hostRef.current?.parentElement ?? null, []);
  /** The part of the shelf on screen, in shelf pixels. */
  const viewport = useCallback(() => {
    const host = hostRef.current, root = rootOf();
    let top = 0, height = FALLBACK_VIEWPORT;
    if (host && root && root.clientHeight > 0) {
      const offset = host.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      top = root.scrollTop - offset; height = root.clientHeight;
    }
    return { top, height };
  }, [rootOf]);
  const measure = useCallback(() => {
    const host = hostRef.current;
    if (host && host.clientWidth > 0) setWidth(current => current === host.clientWidth ? current : host.clientWidth);
    const { top, height } = viewport();
    const next = windowRange(entries, top, height), far = windowRange(entries, top, height, AHEAD_VIEWPORTS);
    setRange(current => current[0] === next[0] && current[1] === next[1] ? current : next);
    setAhead(current => current[0] === far[0] && current[1] === far[1] ? current : far);
  }, [entries, viewport]);
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

  const windowIds = useMemo(() => entries.slice(Math.max(0, ahead[0]), ahead[1] + 1).flatMap(entry => entry.kind === "row" ? entry.cells.map(cell => cell.work.id) : []), [entries, ahead]);
  const windowSignature = windowIds.length ? `${windowIds[0]}:${windowIds.length}:${windowIds[windowIds.length - 1]}` : "";
  const onWindowRef = useRef(onWindow); onWindowRef.current = onWindow;
  useEffect(() => { if (windowIds.length) onWindowRef.current?.(windowIds); }, [windowSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // A changed list waits for its first screen (see `prepare`) while the old shelf stays up.
  const prepareRef = useRef(prepare); prepareRef.current = prepare;
  useLayoutEffect(() => {
    if (!held) { if (shownKey !== key) setShownKey(key); return; }
    if (shownKey === key) return;
    if (!groups.some(group => group.works.length)) { setShownKey(key); return; }
    const controller = new AbortController();
    let finished = false;
    const done = () => { if (finished) return; finished = true; window.clearTimeout(timer); setShownKey(key); };
    const timer = window.setTimeout(done, shownKey === null ? FIRST_HOLD_MS : CHANGE_HOLD_MS);
    // The first screen of the new list at the current scroll position and width.
    const host = hostRef.current, inner = Math.max(1, (host?.clientWidth || width) - gutter * 2);
    const incoming = packSpineShelf(groups, inner, scale), { top, height } = viewport();
    const idsOf = ([first, last]: [number, number]) => incoming.entries.slice(Math.max(0, first), last + 1).flatMap(entry => entry.kind === "row" ? entry.cells.map(cell => cell.work.id) : []);
    const ask = prepareRef.current;
    if (!ask) { done(); return; }
    const pending = ask(idsOf(windowRange(incoming.entries, top, height)), idsOf(windowRange(incoming.entries, top, height, 0)), controller.signal);
    if (pending) pending.then(done, done); else done();
    return () => { window.clearTimeout(timer); if (!finished) { finished = true; controller.abort(); } };
  }, [key, shownKey, held]); // eslint-disable-line react-hooks/exhaustive-deps

  // First appearance: the rows mounted by the first render rise in once; rows scrolled in later do not.
  const entering = useRef<Map<number, number> | null>(null);
  if (entering.current === null && mounted.some(entry => entry.kind === "row")) {
    entering.current = new Map();
    if (entrance && !reducedMotion()) mounted.forEach(entry => { if (entry.kind === "row" && entering.current!.size < 18) entering.current!.set(entry.index, entering.current!.size); });
  }
  const entranceStarted = entering.current !== null;
  useEffect(() => { if (!entranceStarted) return; const timer = window.setTimeout(() => entering.current?.clear(), ENTRANCE_MS); return () => window.clearTimeout(timer); }, [entranceStarted]);

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
  /** The work under a press: its spine or pulled-out case, else (on touch) the nearest one in the row. */
  const workAt = (target: HTMLElement, clientX: number) => {
    const out = target.closest<HTMLElement>(".spine-shelf__out");
    if (out) return out.dataset.id ?? null;
    const spine = target.closest<HTMLElement>(".spine");
    if (spine) return spine.dataset.collectionId ?? null;
    const rowElement = touchTargets ? target.closest<HTMLElement>("[data-shelf-row]") : null;
    return rowElement ? nearestCell(rows[Number(rowElement.dataset.shelfRow)], clientX - rowElement.getBoundingClientRect().left)?.work.id ?? null : null;
  };
  const press = useLongPress({ enabled: Boolean(onLongPress), onLongPress: ({ target, x }) => {
    const id = target instanceof HTMLElement ? workAt(target, x) : null;
    if (id) onLongPress?.(id);
  } });
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
    onPointerDown={press.bind.onPointerDown} onPointerMove={press.bind.onPointerMove} onPointerUp={press.bind.onPointerUp} onPointerCancel={press.bind.onPointerCancel} onPointerLeave={press.bind.onPointerLeave} onContextMenu={onLongPress ? press.bind.onContextMenu : undefined}
    onClick={press.click(onClick)} onKeyDown={onKeyDown}
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
  const [settled, setSettled] = useState(!url || privacy || isSpineWarm(url));
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
