import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CharacterTarget } from "../../characters/api";
import type { FavoriteEntry } from "../../library/types";
import { ContextMenu, type ContextMenuItem } from "../../shared/ui/ContextMenu";
import { HOLD_MS, PRESS_SLOP_PX, movedToIndex } from "../../shared/shelfOrder";
import { displayCount } from "../../shared/displayDate";
import type { FavoriteCatalog } from "./useFavoriteCatalog";
import { FavoritePortrait } from "./FavoritePortrait";

/** The shelf's hold-to-carry gesture and feedback, with hit testing in both axes for a wrapped grid. */
export function FavoriteGrid({ targets, entries, catalog, disabled, menu, onOpen, onOrder }: {
  targets: CharacterTarget[]; entries: FavoriteEntry[]; catalog: FavoriteCatalog; disabled: boolean;
  menu(target: CharacterTarget): ContextMenuItem[]; onOpen(target: CharacterTarget): void; onOrder(ids: string[]): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [carried, setCarried] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const latest = useRef({ targets, onOrder }); latest.current = { targets, onOrder };
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  const down = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (disabled || event.button !== 0 || event.pointerType !== "mouse" || targets.length < 2) return;
    cancel.current?.();
    const source = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY };
    let ghost: HTMLElement | null = null, over = id, lifted = false;
    let frame = 0, pointerY = start.y;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const suppressClick = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
    const cleanup = () => {
      clearTimeout(timer); cancelAnimationFrame(frame); ghost?.remove(); setCarried(null); setPreview(null);
      document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", abort, true); document.removeEventListener("keydown", key, true); window.removeEventListener("blur", abort);
      if (lifted) { document.addEventListener("click", suppressClick, { capture: true, once: true }); setTimeout(() => document.removeEventListener("click", suppressClick, true), 0); }
      cancel.current = null;
    };
    const abort = () => cleanup();
    const key = (keyEvent: KeyboardEvent) => { if (keyEvent.key === "Escape") { keyEvent.preventDefault(); keyEvent.stopPropagation(); cleanup(); } };
    const scroll = () => {
      const scroller = root.current?.closest<HTMLElement>(".favorite-view__scroll");
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (pointerY < box.top + 40) scroller.scrollTop -= 12;
        else if (pointerY > box.bottom - 40) scroller.scrollTop += 12;
      }
      frame = requestAnimationFrame(scroll);
    };
    const move = (moveEvent: PointerEvent) => {
      if (!lifted) { if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) >= PRESS_SLOP_PX) cleanup(); return; }
      moveEvent.preventDefault(); pointerY = moveEvent.clientY;
      const rect = source.getBoundingClientRect();
      ghost!.style.left = `${moveEvent.clientX - rect.width / 2}px`; ghost!.style.top = `${moveEvent.clientY - 40}px`;
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-favorite-card]");
      if (target && root.current?.contains(target) && target.dataset.favoriteCard !== id && target.dataset.favoriteCard !== over) {
        over = target.dataset.favoriteCard!;
        const ids = latest.current.targets.map(item => item.id);
        setPreview(movedToIndex(ids, id, ids.indexOf(over)));
      }
    };
    const up = (upEvent: PointerEvent) => {
      const underPointer = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      if (lifted && over !== id && underPointer && root.current?.contains(underPointer)) {
        const ids = latest.current.targets.map(target => target.id);
        const next = movedToIndex(ids, id, ids.indexOf(over));
        if (next) latest.current.onOrder(next);
      }
      cleanup();
    };
    const timer = setTimeout(() => {
      lifted = true; setCarried(id);
      const rect = source.getBoundingClientRect();
      ghost = source.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-favorite-card"); ghost.classList.add("favorite-carry"); ghost.setAttribute("aria-hidden", "true");
      ghost.style.width = `${rect.width}px`; ghost.style.left = `${rect.left}px`; ghost.style.top = `${rect.top}px`;
      if (!reduced) ghost.style.transform = "rotate(-2deg)";
      document.body.append(ghost); frame = requestAnimationFrame(scroll);
    }, HOLD_MS);
    document.addEventListener("pointermove", move, true); document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", abort, true); document.addEventListener("keydown", key, true); window.addEventListener("blur", abort);
    cancel.current = cleanup;
  };
  const displayed = preview ? preview.flatMap(id => targets.find(target => target.id === id) ?? []) : targets;
  return <div className="favorite-grid" ref={root}>{displayed.map(target => {
    const entry = entries.find(item => item.characterId === target.id);
    const series = catalog.classifications.find(folder => folder.id === target.seriesClassificationId)?.name;
    return <ContextMenu key={target.id} items={menu(target)}><button type="button" className="favorite-card" data-favorite-card={target.id} data-carried={carried === target.id || undefined}
      onPointerDown={event => down(event, target.id)} onClick={() => onOpen(target)} disabled={disabled}>
      <span className="favorite-card__image"><FavoritePortrait coverId={catalog.unavailableAssets.has(entry?.coverAssetId ?? "") ? null : entry?.coverAssetId} thumbnailId={target.thumbnailAssetId} firstAssetId={catalog.firstAssets[target.id]} coverY={entry?.coverY} /><span className="favorite-card__count">{displayCount(catalog.counts[target.id] ?? 0, "장")}</span></span>
      <strong>{target.displayName}</strong><small>{series}</small>
    </button></ContextMenu>;
  })}</div>;
}
