import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { CollectionVolume, CollectionCoverFocus } from "../../library/types";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { StableImage } from "../../shared/ui/StableImage";
import { ShelfScroller } from "../../shared/ui/ShelfScroller";
import { MangaBook } from "./MangaBook";
import { stripPosition } from "./coverStrip";
import { volumeLabel } from "../collectionFormat";

export type MangaWorkData = { volumes: CollectionVolume[]; activeVolumeId: string | null; editionIndex: number; latestKoreanVolume?: number | null; focuses: CollectionCoverFocus[]; ownedNumbers: number[] | null; scope: string; revision: string; ownership: ReactNode; management: ReactNode };
export function editionName(index: number) { return index === 0 ? "기본판" : `대체판 ${index}`; }
/** `coverUrl` resolves a volume cover's full image; each client passes its own (default: the PC's local artwork). */
export function MangaStage({ manga, privacy, title, author, frontReset, coverUrl = workArtworkUrl, onPick, onReady }: { manga: MangaWorkData; privacy: boolean; title: string; author: string | null; frontReset: number; coverUrl?(artworkId: string): string | null; onPick(id: string): void; onReady(): void }) {
  const active = manga.volumes.find(volume => volume.id === manga.activeVolumeId);
  const index = manga.volumes.findIndex(volume => volume.id === active?.id);
  const src = active?.coverArtworkId ? coverUrl(active.coverArtworkId) : null;
  const focus = manga.focuses.find(item => item.volumeId === active?.id && item.coverArtworkId === active?.coverArtworkId)?.focusX ?? null;
  return <div className="work-stage manga-work-stage">
    <MangaBook src={src} title={title} author={author} volumeNumber={active?.volumeNumber ?? null} volumeTitle={active ? volumeLabel(active) : ""} focus={focus} privacy={privacy} frontReset={frontReset} onReady={onReady} />
    {/* Wide edges belong to the immersive work viewer, separate from ownership controls. */}
    <button className="asset-viewer__edge asset-viewer__edge--left" aria-label="이전 권" disabled={index <= 0} onClick={() => onPick(manga.volumes[index - 1].id)}><ChevronLeftIcon /></button>
    <button className="asset-viewer__edge asset-viewer__edge--right" aria-label="다음 권" disabled={index < 0 || index >= manga.volumes.length - 1} onClick={() => onPick(manga.volumes[index + 1].id)}><ChevronRightIcon /></button>
  </div>;
}
/**
 * One spine width for every work (user, 2026-10-01): the width the old count-based formula gave
 * 드래곤 퀘스트 다이의 대모험 (18 volumes) in a 1440×900 PC window with the info panel open —
 * min(30, floor((1100 - 120) / 18) - 2) = 30px. Spines are 120px tall on PC and tablet alike, so
 * the tablet keeps the same width and proportion. Volumes that do not fit scroll sideways.
 */
export const MANGA_SPINE_WIDTH = 30;
/** Keep this much shelf beside the current volume when scrolling it into view. */
const SCROLL_MARGIN = 64;
/**
 * `coverUrl` resolves a volume cover's thumbnail; each client passes its own (default: the PC's local artwork).
 * `list`: the Collections list row — the same books and plank, left-aligned under the row's label.
 */
export function MangaBookcase({ manga, privacy, coverUrl = workArtworkThumbnailUrl, list = false, label = "권별 책장", onPick, onEnlarge }: { manga: MangaWorkData; privacy: boolean; coverUrl?(artworkId: string): string | null; list?: boolean; label?: string; onPick(id: string): void; onEnlarge?(volumeId: string): void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  // Scroll only the shelf (never the page) so the current volume stays in view; centred shelves do not move.
  useLayoutEffect(() => {
    const track = viewport.current?.querySelector<HTMLElement>(".home-shelf__track");
    const spine = track?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!track || !spine) return;
    const shelf = track.getBoundingClientRect(), box = spine.getBoundingClientRect();
    const margin = Math.min(SCROLL_MARGIN, Math.max(0, (shelf.width - box.width) / 2));
    let left = track.scrollLeft;
    if (box.left < shelf.left + margin) left += box.left - shelf.left - margin;
    else if (box.right > shelf.right - margin) left += box.right - shelf.right + margin;
    const first = !placed.current; placed.current = true;
    if (left === track.scrollLeft) return;
    const smooth = !first && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (track.scrollTo) track.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
    else track.scrollLeft = left;
  }, [manga.activeVolumeId]);
  return <div ref={viewport} className={list ? "manga-bookcase manga-bookcase--list" : "work-strip manga-bookcase"} role="group" aria-label={label}><ShelfScroller previousLabel="책장 왼쪽 보기" nextLabel="책장 오른쪽 보기"><div className="manga-bookcase-board"><div className="manga-bookcase-spines">
    {manga.volumes.map(volume => <Spine key={volume.id} volume={volume} latest={volume.volumeNumber === manga.latestKoreanVolume} picked={manga.activeVolumeId === volume.id} privacy={privacy} focus={manga.focuses.find(focus => focus.volumeId === volume.id && focus.coverArtworkId === volume.coverArtworkId)?.focusX ?? null} owned={manga.ownedNumbers === null ? null : manga.ownedNumbers.includes(volume.volumeNumber)} src={volume.coverArtworkId ? coverUrl(volume.coverArtworkId) : null} onPick={() => onPick(volume.id)} onEnlarge={onEnlarge && (() => onEnlarge(volume.id))} />)}
    {!manga.volumes.length && <span className="manga-cover-empty">이 판본의 표지가 없습니다.</span>}
  </div></div></ShelfScroller></div>;
}
function Spine({ volume, latest, picked, privacy, focus, owned, src, onPick, onEnlarge }: { volume: CollectionVolume; latest: boolean; picked: boolean; privacy: boolean; focus: number | null; owned: boolean | null; src: string | null; onPick(): void; onEnlarge?(): void }) {
  const [ratio, setRatio] = useState(.71);
  const full = 120 * ratio;
  const missing = owned === false;
  const image = (front: boolean) => !privacy && src ? <StableImage src={src} alt="" draggable={false} onLoad={event => { if (event.currentTarget.naturalHeight) setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight); }} style={front ? undefined : { objectPosition: `${stripPosition(focus, full, MANGA_SPINE_WIDTH)}% 50%` }} /> : <span className="manga-spine-empty" aria-hidden="true" />;
  return <button type="button" className={`manga-spine${missing ? " manga-spine--missing" : ""}${volume.releaseStatus === "upcoming" ? " manga-spine--upcoming" : ""}`} aria-label={`${volumeLabel(volume)} 보기`} aria-description={volume.releaseStatus === "upcoming" ? `${volume.localReleaseDate ?? ""} 출간 예정` : missing ? "미보유" : undefined} aria-pressed={picked} data-volume-id={volume.id} onClick={onPick} onDoubleClick={onEnlarge} style={{ "--spine-width": `${MANGA_SPINE_WIDTH}px`, "--cover-width": `${full}px` } as CSSProperties}>
    {/* The shelf is a physical object: real cover strip, light only, no invented printing. */}
    {latest && <span className="manga-latest-label">최신</span>}
    <span className="manga-spine-strip" style={picked ? { visibility: "hidden" } : undefined}>{image(false)}<span className="manga-spine-number">{volume.volumeNumber}</span></span>
    {picked && <span className="manga-spine-front">{image(true)}</span>}
    {picked && <span className="manga-picked-number">{volume.volumeNumber}</span>}
    {missing && volume.releaseStatus === "upcoming" && !picked && <span className="manga-upcoming-date">{volume.localReleaseDate?.slice(5).replace("-", ".")}</span>}
  </button>;
}
