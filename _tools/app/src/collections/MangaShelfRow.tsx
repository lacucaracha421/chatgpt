import { useEffect, useRef, type KeyboardEvent } from "react";
import type { CollectionCoverFocus, CollectionVolume } from "../library/types";
import { MangaBookcase, type MangaWorkData } from "./work/MangaBookcase";
import "./work/collectionWork.css";
import "./mangaShelf.css";

/**
 * The Collections 만화 list as shelves (accepted 2026-09-30, docs/prototypes/pc-collection-detail-20260930/):
 * one row per work — its title and owned count, then the work screen's own bookcase of
 * cover-strip spines on the thin plank. PC and tablet share this row; each client loads the
 * volumes, focuses and cover URLs its own way once the row comes near the viewport.
 */

/** The one picked spine across a shelf list: the work and its volume. */
export type MangaShelfPick = { id: string; volumeId: string } | null;

/** The volumes a row shows: the 기본판 (else the first edition present), in volume order — what the work screen opens on. */
export function shelfEditionVolumes<T extends Pick<CollectionVolume, "editionIndex" | "volumeNumber">>(volumes: T[]): T[] {
  if (!volumes.length) return [];
  const edition = volumes.some(volume => volume.editionIndex === 0) ? 0 : Math.min(...volumes.map(volume => volume.editionIndex));
  return volumes.filter(volume => volume.editionIndex === edition).sort((left, right) => left.volumeNumber - right.volumeNumber);
}

/** A row's bookcase data: the volumes, their stored head focus (centre fallback), and the owned count (`null`: none recorded). */
export function mangaShelfData(volumes: CollectionVolume[], focuses: CollectionCoverFocus[], owned: number | null, activeVolumeId: string | null): MangaWorkData {
  return {
    volumes, activeVolumeId, editionIndex: volumes[0]?.editionIndex ?? 0, latestKoreanVolume: null, focuses,
    ownedNumbers: owned === null ? null : volumes.filter(volume => volume.volumeNumber <= owned).map(volume => volume.volumeNumber),
    scope: "", revision: "", ownership: null, management: null,
  };
}

/** The nearest scrolling ancestor, so rows below the fold are observed against the list, not the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/** Rows this far beyond the list's visible edge already load, so scrolling meets ready shelves. */
const NEAR_MARGIN = "600px 0px";

export function MangaShelfRow({ id, title, owned, manga, privacy, coverUrl, onNear, onPick, onOpen, onEnlarge }: {
  id: string; title: string;
  /** Owned volumes in the shown edition; `null` when none is recorded. */owned: number | null;
  /** `null` until the row's volumes are loaded: the empty plank holds the row's place. */manga: MangaWorkData | null;
  privacy: boolean; coverUrl(artworkId: string): string | null;
  /** Called once, when the row first comes near the visible part of the list. */onNear(): void;
  onPick(volumeId: string): void;
  /** Opens the work, at `volumeId` when one is given. */onOpen(volumeId: string | null): void;
  /** Double-click on a spine (PC); the tablet opens with a second tap instead. */onEnlarge?(volumeId: string): void;
}) {
  const row = useRef<HTMLElement>(null);
  const near = useRef(onNear); near.current = onNear;
  useEffect(() => {
    const element = row.current; if (!element) return;
    if (typeof IntersectionObserver === "undefined") { near.current(); return; }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect(); near.current();
    }, { root: scrollParent(element), rootMargin: NEAR_MARGIN });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Enter on the picked spine opens the work there; on any other spine it picks (the button's click).
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const spine = (event.target as HTMLElement).closest<HTMLElement>("[data-volume-id]");
    if (event.key !== "Enter" || !spine || spine.getAttribute("aria-pressed") !== "true") return;
    event.preventDefault(); onOpen(spine.dataset.volumeId ?? null);
  };
  return <section ref={row} className="manga-shelf-row" aria-label={title}>
    <div className="manga-shelf-row__label">
      <button type="button" className="manga-shelf-row__title" data-collection-id={id} onClick={() => onOpen(null)}>{title}</button>
      {owned !== null && <span className="manga-shelf-row__count numeric" aria-label={`보유 ${owned.toLocaleString()}권`}>{owned.toLocaleString()}권</span>}
    </div>
    <div className="manga-shelf-row__shelf" onKeyDown={keyDown}>
      {manga
        ? <MangaBookcase list label={`${title} 책장`} manga={manga} privacy={privacy} coverUrl={coverUrl} onPick={onPick} onEnlarge={onEnlarge} />
        : <div className="manga-bookcase manga-bookcase--list" aria-hidden="true"><div className="manga-shelf-row__waiting"><div className="manga-bookcase-board" /></div></div>}
    </div>
  </section>;
}
