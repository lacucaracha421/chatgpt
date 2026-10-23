import type { CollectionCoverFocus, CollectionVolume } from "../library/types";
import { useLongPress } from "../shared/useLongPress";
import { MangaBookcase, type MangaWorkData, type MangaShelfBack } from "./work/MangaBookcase";
import "./work/collectionWork.css";
import "./mangaShelf.css";
import { mangaShelfStyle } from "./mangaDimensions";

/**
 * A contiguous work run on a shared shelf, with its paper label on the plank front.
 * PC and tablet share this run; shelf rows own observation and each client supplies its media.
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

export function MangaShelfRow({ id, title, author = null, publisher = null, owned, manga, privacy, coverUrl, onPick, onOpen, onEnlarge, onLongPress, touchTargets = false, useBack, pullPending, start = 0, count, seriesKey, seriesScan }: {
  id: string; title: string; author?: string | null; publisher?: string | null;
  /** Owned volumes in the shown edition; `null` when none is recorded. */owned: number | null;
  /** `null` until the row's volumes are loaded: the empty plank holds the row's place. */manga: MangaWorkData | null;
  touchTargets?: boolean;
  start?: number; count?: number;
  seriesKey?: string; seriesScan?: boolean;
  privacy: boolean; coverUrl(artworkId: string): string | null;
  useBack?: MangaShelfBack;
  pullPending?: boolean;
  onPick(volumeId: string): void;
  /** Opens the work, at `volumeId` when one is given. */onOpen(volumeId: string | null): void;
  /** Open the pulled-out book. */onEnlarge?(volumeId: string): void;
  /** Tablet: a long press anywhere on the row asks for the work's action sheet. */onLongPress?(): void;
}) {
  // Owned next to the volumes on the shelf ("1 / 8권"), once the row's volumes are known and the count fits them.
  const total = manga && owned !== null && owned <= manga.volumes.length ? manga.volumes.length : null;
  const press = useLongPress({ enabled: Boolean(onLongPress), onLongPress: () => onLongPress?.() });
  const countText = owned === null ? "" : total ? `${owned.toLocaleString()} / ${total.toLocaleString()}권` : `${owned.toLocaleString()}권`;
  return <section className="manga-shelf-run" style={mangaShelfStyle(touchTargets)} aria-label={title} onClickCapture={onLongPress ? press.captureClick : undefined}
    onPointerDown={press.bind.onPointerDown} onPointerMove={press.bind.onPointerMove} onPointerUp={press.bind.onPointerUp} onPointerCancel={press.bind.onPointerCancel} onPointerLeave={press.bind.onPointerLeave} onContextMenu={onLongPress ? press.bind.onContextMenu : undefined}>
    <div className="manga-shelf-row__shelf" onKeyDownCapture={event => {
      const spine = (event.target as Element).closest<HTMLElement>("button[data-volume-id]");
      if (event.key !== "Enter" || spine?.getAttribute("aria-pressed") !== "true") return;
      event.preventDefault(); event.stopPropagation(); onOpen(spine.dataset.volumeId ?? null);
    }}>
      {manga
        ? <MangaBookcase seriesKey={seriesKey} seriesScan={seriesScan} range={count === undefined ? undefined : { start, count }} pullPending={pullPending} useBack={useBack} title={title} author={author} publisher={publisher} touchTargets={touchTargets} list label={`${title} 책장`} manga={manga} privacy={privacy} coverUrl={coverUrl} onPick={onPick} onEnlarge={onEnlarge ?? onOpen} />
        : <div className="manga-shelf-row__waiting" aria-hidden="true" />}
    </div>
    <button type="button" className="manga-shelf-row__label" data-collection-id={id} aria-label={title} aria-description={[start > 0 ? "앞 선반에서 이어짐" : "", countText].filter(Boolean).join(". ")} title={`${title}${start > 0 ? " ›" : ""}${countText ? ` · ${countText}` : ""}`} onClick={() => onOpen(null)}>
      <span>{title}{start > 0 ? " ›" : ""}{countText && <> · <span className="numeric" aria-label={total ? `보유 ${owned!.toLocaleString()}권 / 전체 ${total.toLocaleString()}권` : `보유 ${owned!.toLocaleString()}권`}>{countText}</span></>}</span>
    </button>
  </section>;
}
