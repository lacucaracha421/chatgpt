import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { useLongPress } from "../shared/useLongPress";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { CASE_PLASTIC, CollectionCase, CaseSpine, spineInsertClass, type CaseData } from "./case/CollectionCase";
import { handOffCaseAngle } from "./case/caseHandoff";
import { playShelfSound, preloadShelfSounds } from "./case/caseSounds";
import { stageForCaseHeight } from "./case/fitCaseStage";
import { cellAtX, nearestCell, packSpineShelf, SPINE_SHELF, spineScaleForView, type PackedCell, type PackedEntry, type PackedRow, type PackedWork, type ShelfGroup } from "./spineShelfLayout";
import { workCaseSize, type CaseSizeMm } from "./case/caseDimensions";
import { isSpineWarm } from "./spineShelfWarm";
import "./SpineShelf.css";

/** One case on the 책장: plain data, so the PC and the tablet draw it the same way. */
export type SpineWork = PackedWork & {
  title: string; credit: string; developer: string | null;
  /** Front cover shown when the case is pulled out; spine artwork shown on the spine. */
  front: string | null; spine: string | null;
  /** The stored back cover (AV jacket split); without it the pulled-out case prints a back from the work's own data. */
  back?: string | null;
  year?: number | null;
  coverFocus?: number | null;
  /** The owned device or spine artwork is not read yet: the spine stays plastic only, at its final size. */
  pending: boolean;
};
/**
 * Where a client gets its image URLs. The default reads them off the work; the tablet swaps in hooks that
 * request a ticket per image. The hooks are called once per mounted spine or pulled-out cover.
 */
export type SpineArt<W extends SpineWork> = {
  useSpine(work: W, host: RefObject<Element | null>): { url: string | null; pending: boolean };
  /**
   * The images of the one pulled-out case: its faces are held large, so a client may serve them from the full-size artwork
   * (keeping the smaller image on screen until that is decoded). `pending`: the spine is not read yet.
   */
  usePulled(work: W, host: RefObject<Element | null>): { front: string | null; spine: string | null; back: string | null; pending: boolean };
};
const WORK_ART: SpineArt<SpineWork> = {
  useSpine: work => ({ url: work.spine, pending: work.pending }),
  usePulled: work => ({ front: work.front, spine: work.spine, back: work.back ?? null, pending: work.pending }),
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
const NO_IDS: readonly string[] = [];
/** Spine artwork fading in over its stand-in (SpineShelf.css). */
const SPINE_FADE_MS = 140;
/** The put-back move (`spine-out-home` in SpineShelf.css); the spine shows again when it ends. */
const PUT_BACK_MS = 440;
/** The pulled-out case is held a little closer than the shelf: this much taller than its spine, and lifted off the plank. */
const PULL_GROW = 1.28;
const PULL_LIFT = 12;
/**
 * The spine stays on the shelf until the pulled-out case has painted its faces (front, spine, back), so the swap
 * never shows a blank case; a slow image waits at most this long and then fills in on the case.
 */
const PREPARE_CAP_MS = 350;
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
  /** Also put the `restoredFocusId` case back out (a return from its work screen); otherwise it only gets focus. */
  restorePick?: boolean;
  menu?(id: string): ContextMenuItem[];
  /** Tablet: a long press on a work (or, with `touchTargets`, the spine at that x in the row) asks for its action sheet. */
  onLongPress?(id: string): void;
  art?: SpineArt<W>;
  /** The works near the viewport (the mounted rows and the ones just beyond), when that set changes: a client may read their artwork lazily. */
  onWindow?(ids: string[]): void;
  /**
   * Set when a client reads artwork lazily. When the list changes (another sort, filter or scope) the shelf keeps
   * showing the old one until this resolves for the new first screen: `ids` are the works of the rows that will be
   * mounted, `visible` those on screen. The wait is bounded; after it the new list is shown whatever has arrived.
   * Aborted when the list changes again before it resolved. Returning nothing means it is ready already: the new
   * list replaces the old one before the next paint. Movies may return board sizes read from the existing posters;
   * those sizes commit with the incoming list, never after its first paint.
   */
  prepare?(ids: string[], visible: string[], signal: AbortSignal): Promise<void | ReadonlyMap<string, CaseSizeMm>> | void;
  /** The rows of a first appearance rise in once, staggered by row. */
  entrance?: boolean;
  controlRef?: { current: SpineShelfControl | null };
};

export function SpineShelf<W extends SpineWork>({ groups, scale: chosenScale, label, pickedId, onPick, onOpen, privacy = false, touchTargets = false, gutter = 24, restoredFocusId, restorePick = false, menu, onLongPress, art, onWindow, entrance = false, controlRef, prepare }: Props<W>) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(preloadShelfSounds, []);
  const [width, setWidth] = useState(960);
  const [viewHeight, setViewHeight] = useState(0);
  const scale = spineScaleForView(chosenScale, viewHeight, { grow: PULL_GROW, lift: PULL_LIFT });
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
  // Poster dimensions arrive with preparation, before the incoming shelf paints. If the wait caps out,
  // retain the default board size for this list so a late poster cannot move its title band.
  const [posterSizes, setPosterSizes] = useState<ReadonlyMap<string, CaseSizeMm>>(new Map());
  const sourceGroups = live ? groups : lastGroups.current;
  const shownGroups = useMemo(() => sourceGroups.map(group => ({ ...group, works: group.works.map(work =>
    work.platform === "film" ? { ...work, size: posterSizes.get(work.id) ?? work.size ?? workCaseSize("film") } : work) })), [sourceGroups, posterSizes]);
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
    const rootHeight = rootOf()?.clientHeight ?? 0;
    if (rootHeight > 0) setViewHeight(current => current === rootHeight ? current : rootHeight);
    const { top, height } = viewport();
    const next = windowRange(entries, top, height), far = windowRange(entries, top, height, AHEAD_VIEWPORTS);
    setRange(current => current[0] === next[0] && current[1] === next[1] ? current : next);
    setAhead(current => current[0] === far[0] && current[1] === far[1] ? current : far);
  }, [entries, viewport, rootOf]);
  const measureRef = useRef(measure); measureRef.current = measure;
  // Another 책등 크기 repacks every row: the row that was at the top of the view stays there, at the same share of its
  // height, so the size changes in one step around what was being looked at instead of jumping elsewhere.
  const sized = useRef({ scale, rows });
  useLayoutEffect(() => {
    const before = sized.current; sized.current = { scale, rows };
    if (before.scale === scale) return;
    const host = hostRef.current, root = rootOf();
    if (!host || !root || !before.rows.length) return;
    const offset = host.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    const top = root.scrollTop - offset;
    if (top <= 0) return;
    const old = before.rows.find(row => row.top + row.height > top) ?? before.rows[before.rows.length - 1];
    const cell = cells.get(old.cells[0].work.id);
    if (!cell) return;
    const next = rows[cell.row];
    root.scrollTop = offset + next.top + Math.min(1, (top - old.top) / old.height) * next.height;
  }, [scale, rows, cells, rootOf]);
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

  // Put-back: the case of a pick that ended turns back into its spine before it goes. It is worked out while rendering,
  // so the very commit that drops the pick shows that case leaving: it is never unmounted and mounted again (which
  // showed the spine at once and replayed the move later). Several can be on their way back at once.
  // At the end of its move a case is `landing`: its spine shows again under it, and the case goes only once the spine
  // has been painted (two frames), so a spine whose image the WebView let go of while hidden never shows blank.
  const [pickTrack, setPickTrack] = useState<{ picked: string | null; leaving: readonly string[]; landing: readonly string[] }>({ picked: pickedId, leaving: NO_IDS, landing: NO_IDS });
  let leavingIds = pickTrack.leaving, landingIds = pickTrack.landing;
  if (pickTrack.picked !== pickedId) {
    const before = pickTrack.picked;
    const next = pickTrack.leaving.filter(id => id !== pickedId && id !== before);
    if (before && !reducedMotion()) next.push(before);
    const landed = pickTrack.landing.filter(id => id !== pickedId && id !== before);
    leavingIds = next.length ? next : NO_IDS;
    landingIds = landed.length === pickTrack.landing.length ? pickTrack.landing : landed.length ? landed : NO_IDS;
    setPickTrack({ picked: pickedId, leaving: leavingIds, landing: landingIds });
  }

  // Rows that stay mounted outside the window: the picked and leaving cases, the tab stop and the one focus returns to.
  const pinned = useMemo(() => {
    const set = new Set<number>();
    for (const id of [pickedId, tabbableId, restoredFocusId, ...leavingIds, ...landingIds]) { const cell = id ? cells.get(id) : undefined; if (cell) set.add(cell.row); }
    return set;
  }, [pickedId, tabbableId, restoredFocusId, leavingIds, landingIds, cells]);
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
    const done = (sizes?: void | ReadonlyMap<string, CaseSizeMm>) => { if (finished) return; finished = true; window.clearTimeout(timer); if (sizes) setPosterSizes(sizes); setShownKey(key); };
    const timer = window.setTimeout(done, shownKey === null ? FIRST_HOLD_MS : CHANGE_HOLD_MS);
    // The first screen of the new list at the current scroll position and width.
    const host = hostRef.current, inner = Math.max(1, (host?.clientWidth || width) - gutter * 2);
    const incoming = packSpineShelf(groups, inner, scale), { top, height } = viewport();
    const idsOf = ([first, last]: [number, number]) => incoming.entries.slice(Math.max(0, first), last + 1).flatMap(entry => entry.kind === "row" ? entry.cells.map(cell => cell.work.id) : []);
    const ask = prepareRef.current;
    if (!ask) { done(); return; }
    const pending = ask(idsOf(windowRange(incoming.entries, top, height)), idsOf(windowRange(incoming.entries, top, height, 0)), controller.signal);
    if (pending) pending.then(done, () => done()); else done();
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

  // Put-back timers: each leaving case lands when its own move has ended, and goes two frames after its spine shows.
  const leaveTimers = useRef(new Map<string, number>());
  useEffect(() => {
    const timers = leaveTimers.current;
    for (const id of leavingIds) if (!timers.has(id)) timers.set(id, window.setTimeout(() => {
      timers.delete(id);
      setPickTrack(track => track.leaving.includes(id) ? { ...track, leaving: track.leaving.filter(item => item !== id), landing: [...track.landing, id] } : track);
    }, PUT_BACK_MS + 20));
    for (const [id, timer] of timers) if (!leavingIds.includes(id)) { window.clearTimeout(timer); timers.delete(id); }
  }, [leavingIds]);
  const landFrames = useRef(new Map<string, number>());
  useEffect(() => {
    const frames = landFrames.current;
    for (const id of landingIds) if (!frames.has(id)) frames.set(id, requestAnimationFrame(() => frames.set(id, requestAnimationFrame(() => {
      frames.delete(id);
      setPickTrack(track => ({ ...track, landing: track.landing.filter(item => item !== id) }));
    }))));
    for (const [id, frame] of frames) if (!landingIds.includes(id)) { cancelAnimationFrame(frame); frames.delete(id); }
  }, [landingIds]);
  useEffect(() => () => {
    const timers = leaveTimers.current, frames = landFrames.current;
    timers.forEach(timer => window.clearTimeout(timer)); timers.clear();
    frames.forEach(frame => cancelAnimationFrame(frame)); frames.clear();
  }, []);
  // A case put back out by a returning visit is already in the hand: it appears pulled out, without the move.
  const stillPick = useRef<string | null>(null);
  useEffect(() => { if (pickedId !== stillPick.current) stillPick.current = null; }, [pickedId]);
  const still = pickedId !== null && stillPick.current === pickedId ? pickedId : null;
  // The work screen's case starts at the angle the pulled-out case was turned to, so the hero move reads as one object.
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  const open = useCallback((id: string) => {
    const kase = [...hostRef.current?.querySelectorAll<HTMLElement>(".spine-shelf__out") ?? []].find(out => out.dataset.id === id)?.querySelector<HTMLElement>(".kase");
    if (kase?.dataset.angle) handOffCaseAngle(id, Number(kase.dataset.angle));
    onOpenRef.current(id);
  }, []);

  // A returning visit focuses the remembered case; a return from its work screen also puts it back out.
  const restored = useRef<string | null>(null);
  const restorePickRef = useRef(restorePick); restorePickRef.current = restorePick;
  useEffect(() => {
    if (!restoredFocusId || restored.current === restoredFocusId || !cells.has(restoredFocusId)) return;
    restored.current = restoredFocusId; setFocusId(restoredFocusId);
    if (restorePickRef.current) { stillPick.current = restoredFocusId; onPick(restoredFocusId); }
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
    if (pickedId === id) { open(id); return; }
    setFocusId(id); onPick(id);
  };
  /** The work under a press: its spine or pulled-out case, else (on touch) the spine at that x in the row; empty shelf has none. */
  const workAt = (target: HTMLElement, clientX: number) => {
    const out = target.closest<HTMLElement>(".spine-shelf__out");
    if (out) return out.dataset.id ?? null;
    const spine = target.closest<HTMLElement>(".spine");
    if (spine) return spine.dataset.collectionId ?? null;
    const rowElement = touchTargets ? target.closest<HTMLElement>("[data-shelf-row]") : null;
    return rowElement ? cellAtX(rows[Number(rowElement.dataset.shelfRow)], clientX - rowElement.getBoundingClientRect().left)?.work.id ?? null : null;
  };
  const press = useLongPress({ enabled: Boolean(onLongPress), onLongPress: ({ target, x }) => {
    const id = target instanceof HTMLElement ? workAt(target, x) : null;
    if (id) onLongPress?.(id);
  } });
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const out = target.closest<HTMLElement>(".spine-shelf__out");
    if (out) {
      // The case is the work's 3D model: a click on it (not the end of a turn) opens through its own handler.
      // The scroller's put-down must not take it away either way.
      event.stopPropagation();
      if (!target.closest(".kase")) open(out.dataset.id!);
      return;
    }
    const spine = target.closest<HTMLElement>(".spine");
    if (spine) { activate(spine.dataset.collectionId!); return; }
    const rowElement = touchTargets ? target.closest<HTMLElement>("[data-shelf-row]") : null;
    if (rowElement) {
      const under = cellAtX(rows[Number(rowElement.dataset.shelfRow)], event.clientX - rowElement.getBoundingClientRect().left);
      if (under) {
        // The scroller's put-down must not undo this pick.
        event.stopPropagation(); activate(under.work.id); return;
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
      case "Enter": event.preventDefault(); if (pickedId === id) open(id); else { setFocusId(id); onPick(id); } return;
      case " ": event.preventDefault(); if (pickedId === id) onPick(null); else { setFocusId(id); onPick(id); } return;
      case "Escape":
        if (!pickedId) return;
        event.preventDefault(); event.stopPropagation();
        // From the turned case, focus goes back to its spine as it returns.
        if (holder.classList.contains("spine-shelf__out")) { pendingFocus.current = id; setFocusId(id); }
        onPick(null); return;
      default: return;
    }
    event.preventDefault();
    if (next) moveTo(next, true);
  };

  const entranceOf = (row: PackedRow<W>) => entering.current?.get(row.index);
  const inRow = (row: PackedRow<W>, list: readonly string[]) => { const ids = list.filter(id => row.cells.some(cell => cell.work.id === id)); return ids.length ? ids : NO_IDS; };
  return <div ref={hostRef} className="spine-shelf" role="group" aria-label={label}
    style={{ height: packed.height, "--spine-scale": scale, "--spine-gutter": `${gutter}px` } as CSSProperties}
    onPointerDown={press.bind.onPointerDown} onPointerMove={press.bind.onPointerMove} onPointerUp={press.bind.onPointerUp} onPointerCancel={press.bind.onPointerCancel} onPointerLeave={press.bind.onPointerLeave} onContextMenu={onLongPress ? press.bind.onContextMenu : undefined}
    onClick={press.click(onClick)} onKeyDown={onKeyDown}
    onFocus={event => { const spine = (event.target as HTMLElement).closest<HTMLElement>(".spine"); if (spine?.dataset.collectionId) setFocusId(spine.dataset.collectionId); }}>
    {mounted.map(entry => entry.kind === "label"
      ? <div key={`label:${entry.top}`} className="spine-shelf__label" style={{ top: entry.top, height: entry.height }}><SectionLabel title={entry.label} count={entry.count} /></div>
      : <ShelfRow<W> key={`row:${entry.index}`} row={entry} available={available} picked={entry.cells.some(cell => cell.work.id === pickedId) ? pickedId : null}
        leaving={inRow(entry, leavingIds.length || landingIds.length ? [...leavingIds, ...landingIds] : NO_IDS)} landing={inRow(entry, landingIds)}
        still={entry.cells.some(cell => cell.work.id === still) ? still : null} onOpen={open}
        tabbable={entry.cells.some(cell => cell.work.id === tabbableId) ? tabbableId : null} privacy={privacy} menu={menu} art={(art ?? WORK_ART) as SpineArt<W>} entering={entranceOf(entry)} />)}
  </div>;
}

type RowProps<W extends SpineWork> = {
  row: PackedRow<W>; available: number; picked: string | null; leaving: readonly string[]; landing: readonly string[]; still: string | null; tabbable: string | null; privacy: boolean;
  menu?(id: string): ContextMenuItem[]; art: SpineArt<W>; entering?: number; onOpen(id: string): void;
};
function ShelfRowView<W extends SpineWork>({ row, available, picked, leaving, landing, still, tabbable, privacy, menu, art, entering, onOpen }: RowProps<W>) {
  const board = useRef<HTMLDivElement>(null);
  const outs = [picked, ...leaving].filter((id, index, list): id is string => Boolean(id) && list.indexOf(id) === index);
  // The pulled-out cases that have painted: only their spines hide, in the same commit as the case appears.
  const [shown, setShown] = useState<readonly string[]>([]);
  const onShown = useCallback((id: string, on: boolean) => setShown(list => on ? list.includes(id) ? list : [...list, id] : list.includes(id) ? list.filter(item => item !== id) : list), []);
  // The row holding a case out paints over its neighbours: the case may reach into the rows above and below.
  return <div className={`spine-shelf__row${entering !== undefined ? " is-entering" : ""}${outs.length ? " is-holding" : ""}`} data-shelf-row={row.index}
    style={{ top: row.top, height: row.height, "--board-height": `${row.board}px`, ...(entering !== undefined ? { "--i": entering } : {}) } as CSSProperties}>
    <div ref={board} className="spine-shelf__board">
      <div className="spine-shelf__spines">
        {row.cells.map(cell => <Spine<W> key={cell.work.id} cell={cell} picked={picked === cell.work.id} out={outs.includes(cell.work.id) && shown.includes(cell.work.id) && !landing.includes(cell.work.id)} tabbable={tabbable === cell.work.id} privacy={privacy} menu={menu} art={art} />)}
      </div>
      {outs.map(id => {
        const cell = row.cells.find(item => item.work.id === id)!;
        return <PulledOut<W> key={id} cell={cell} row={row} available={available} leaving={id !== picked} still={id === still} privacy={privacy} art={art} onOpen={onOpen} onShown={onShown} />;
      })}
    </div>
  </div>;
}
const ShelfRow = memo(ShelfRowView) as typeof ShelfRowView;

function SpineView<W extends SpineWork>({ cell, picked, out, tabbable, privacy, menu, art }: { cell: PackedCell<W>; picked: boolean; out: boolean; tabbable: boolean; privacy: boolean; menu?(id: string): ContextMenuItem[]; art: SpineArt<W> }) {
  const { work } = cell;
  const host = useRef<HTMLButtonElement>(null);
  const { url, pending } = art.useSpine(work, host);
  const button = <button ref={host} type="button" className={`spine${work.platform === "film" ? " spine--board" : ""}`} data-collection-id={work.id} tabIndex={tabbable ? 0 : -1}
    aria-label={work.credit ? `${work.title} · ${work.credit}` : work.title} aria-pressed={picked} data-out={out || undefined}
    style={{ "--w": `${cell.width}px`, "--h": `${cell.height}px`, "--poster-height": `${cell.height}px`, "--plastic": CASE_PLASTIC[work.platform] } as CSSProperties}>
    <span className="spine__case">{(privacy || !pending || work.platform === "film") && <SpineArtView key={work.platform === "film" ? "poster" : url ?? "template"} work={work} url={url} privacy={privacy} ratio={cell.coverWidth / cell.height} />}</span>
  </button>;
  return menu ? <ContextMenu items={menu(work.id)}>{button}</ContextMenu> : button;
}
const Spine = memo(SpineView) as typeof SpineView;

/**
 * The printed insert. A template appears in one step. Spine artwork that is not decoded yet stands in as the drawn
 * template, so it shows with its neighbours, and the artwork fades in over it once decoded.
 */
function SpineArtView({ work, url, privacy, ratio }: { work: SpineWork; url: string | null; privacy: boolean; ratio: number }) {
  const [settled, setSettled] = useState(!url || privacy || isSpineWarm(url));
  const [standIn, setStandIn] = useState(!settled);
  useEffect(() => {
    if (!settled || !standIn) return;
    const timer = window.setTimeout(() => setStandIn(false), SPINE_FADE_MS + 20);
    return () => window.clearTimeout(timer);
  }, [settled, standIn]);
  const data: CaseData = { title: work.title, platform: work.platform, developer: work.developer, front: null, spine: url, privacy, year: work.year, coverFocus: work.coverFocus, posterRatio: ratio, board: work.platform === "film" };
  const settle = useCallback(() => setSettled(true), []);
  return <span className={spineInsertClass(data)} data-settled={work.platform === "film" || settled}>
    {work.platform !== "film" && standIn && <span className="spine__stand-in" aria-hidden="true"><CaseSpine decorative data={{ ...data, spine: null }} /></span>}
    <CaseSpine decorative data={data} onSettled={settle} />
  </span>;
}

/**
 * Where the pulled-out case is held, in board pixels: a little taller than its spine, centred over its slot within
 * the row, lifted off the plank (lower instead when the top of the shelf would cut it). `from` is the wrapper
 * transform that lays the edge-on 3D case exactly over its spine, where the pull starts and the put-back ends.
 */
function pullPose(cell: PackedCell<SpineWork>, row: PackedRow<SpineWork>, available: number) {
  const height = Math.round(cell.height * PULL_GROW), width = Math.round(height * cell.coverWidth / cell.height);
  const center = cell.x + cell.width / 2;
  const left = Math.max(0, Math.min(available - width, center - width / 2));
  const top = row.top + SPINE_SHELF.rowTop + row.board - PULL_LIFT - height;
  const lift = PULL_LIFT + Math.min(0, top);
  // Edge-on, the spine faces the viewer half a case width nearer than the case's middle, so the case's perspective
  // (2200px on screen, CollectionCase.css) draws it larger and lower: the start scale and offset take that back out.
  const near = 2200 / (2200 - width / 2), scale = cell.height / height / near;
  const dx = center - (left + width / 2), dy = lift - scale * height * (near - 1) / 2;
  return { left, width, height, lift, from: `translate(${dx.toFixed(2)}px, calc(${dy.toFixed(2)}px + var(--start-lift, 0px))) scale(${scale.toFixed(4)})` };
}

/**
 * The picked case, pulled out of its slot toward the viewer and turned to its front in one move (PC and tablet).
 * It is the work screen's own 3D case: a drag turns it, a click opens the work. Put back, it turns edge-on and
 * slides into its slot. Only this case is a full model; the others stay flat spines.
 */
function PulledOutView<W extends SpineWork>({ cell, row, available, leaving, still, privacy, art, onOpen, onShown }: { cell: PackedCell<W>; row: PackedRow<W>; available: number; leaving: boolean; still: boolean; privacy: boolean; art: SpineArt<W>; onOpen(id: string): void; onShown(id: string, shown: boolean): void }) {
  const host = useRef<HTMLDivElement>(null);
  const { front, spine, back, pending: spinePending } = art.usePulled(cell.work, host);
  const id = cell.work.id;
  // Painted: the case's images are decoded (or the cap ran out). Until then it is laid out but transparent and the
  // spine stays on the shelf; then both swap in one commit and the pull starts. A case put back before it painted
  // just goes, as its spine never left.
  const [painted, setPainted] = useState(still);
  const pendingRef = useRef(spinePending); pendingRef.current = spinePending;
  useEffect(() => {
    if (painted) return;
    const timer = window.setTimeout(() => setPainted(true), PREPARE_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [painted]);
  // Before paint, so the spine hides in the same frame as the case appears.
  useLayoutEffect(() => { if (painted) onShown(id, true); }, [painted, id, onShown]);
  useLayoutEffect(() => () => onShown(id, false), [id, onShown]);
  const pose = pullPose(cell, row, available);
  const stage = useMemo(() => stageForCaseHeight(pose.height), [pose.height]);
  // Put back from wherever it was turned: to the nearer edge-on angle with the spine toward the viewer.
  useLayoutEffect(() => {
    if (!leaving) return;
    const angle = Number(host.current?.querySelector<HTMLElement>(".kase")?.dataset.angle ?? 28);
    host.current?.style.setProperty("--ry-home", `${angle < -90 ? -270 : 90}deg`);
  }, [leaving]);
  // The pull plays once; afterwards the case rests and turns only by hand. Picked again on its way back, it comes out again.
  const [pulled, setPulled] = useState(still);
  const [wasLeaving, setWasLeaving] = useState(leaving);
  if (wasLeaving !== leaving) { setWasLeaving(leaving); if (!leaving) setPulled(false); }
  // 빼기 as the pull starts, 넣기 as the put-back starts; a case put back before it painted never left, so it is silent.
  const sounding = !painted ? null : leaving ? "in" : pulled ? null : "out";
  useEffect(() => { if (sounding) playShelfSound(sounding); }, [sounding]);
  const data: CaseData = { title: cell.work.title, platform: cell.work.platform, developer: cell.work.developer, front, spine, back, privacy, year: cell.work.year, coverFocus: cell.work.coverFocus, posterRatio: cell.coverWidth / cell.height, board: cell.work.platform === "film" };
  if (leaving && !painted) return null;
  return <div ref={host} className={`spine-shelf__out${!painted ? " is-preparing" : leaving ? " is-leaving" : pulled ? "" : " is-pulling"}`} data-id={id}
    onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === "spine-out-pull") setPulled(true); }}
    style={{ left: pose.left, "--out-w": `${pose.width}px`, "--out-h": `${pose.height}px`, "--lift": `${pose.lift}px`, "--from": pose.from,
      // The model keeps the package's real thickness (CASE_MM), so edge-on it is exactly the spine it replaces.
      "--out-depth": `${(520 * cell.width / cell.height).toFixed(2)}px`, "--shadow-edge": (cell.width / (pose.width * .92 * cell.height / pose.height)).toFixed(4) } as CSSProperties}>
    <CollectionCase data={data} open={false} stageBox={stage} onOpenChange={() => onOpen(id)} onReady={() => { if (!pendingRef.current) setPainted(true); }} />
  </div>;
}
const PulledOut = memo(PulledOutView) as typeof PulledOutView;
