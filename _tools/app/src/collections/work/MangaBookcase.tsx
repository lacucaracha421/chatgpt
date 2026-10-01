import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { CollectionVolume, CollectionCoverFocus } from "../../library/types";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { StableImage } from "../../shared/ui/StableImage";
import { MangaBook } from "./MangaBook";
import { stripPosition } from "./coverStrip";
import { volumeLabel } from "../collectionFormat";

export type MangaWorkData = { volumes: CollectionVolume[]; activeVolumeId: string | null; editionIndex: number; latestKoreanVolume?: number | null; focuses: CollectionCoverFocus[]; ownedNumbers: number[] | null; scope: string; revision: string; ownership: ReactNode; management: ReactNode };
export function editionName(index: number) { return index === 0 ? "기본판" : `대체판 ${index}`; }
export function MangaStage({ manga, privacy, title, author, frontReset, onPick, onReady }: { manga: MangaWorkData; privacy: boolean; title: string; author: string | null; frontReset: number; onPick(id: string): void; onReady(): void }) {
  const active = manga.volumes.find(volume => volume.id === manga.activeVolumeId);
  const index = manga.volumes.findIndex(volume => volume.id === active?.id);
  const src = active?.coverArtworkId ? workArtworkUrl(active.coverArtworkId) : null;
  const focus = manga.focuses.find(item => item.volumeId === active?.id && item.coverArtworkId === active?.coverArtworkId)?.focusX ?? null;
  return <div className="work-stage manga-work-stage">
    <MangaBook src={src} title={title} author={author} volumeNumber={active?.volumeNumber ?? null} volumeTitle={active ? volumeLabel(active) : ""} focus={focus} privacy={privacy} frontReset={frontReset} onReady={onReady} />
    {/* Wide edges belong to the immersive work viewer, separate from ownership controls. */}
    <button className="asset-viewer__edge asset-viewer__edge--left" aria-label="이전 권" disabled={index <= 0} onClick={() => onPick(manga.volumes[index - 1].id)}><ChevronLeftIcon /></button>
    <button className="asset-viewer__edge asset-viewer__edge--right" aria-label="다음 권" disabled={index < 0 || index >= manga.volumes.length - 1} onClick={() => onPick(manga.volumes[index + 1].id)}><ChevronRightIcon /></button>
  </div>;
}
export function MangaBookcase({ manga, privacy, onPick, onEnlarge }: { manga: MangaWorkData; privacy: boolean; onPick(id: string): void; onEnlarge?(): void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    const node = viewport.current; if (!node) return;
    const measure = () => setWidth(node.clientWidth || 960); measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure); observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    viewport.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [manga.activeVolumeId]);
  const stripWidth = Math.max(14, Math.min(30, Math.floor((width - 120) / Math.max(1, manga.volumes.length)) - 2));
  return <div ref={viewport} className="work-strip manga-bookcase" role="group" aria-label="권별 책장"><div className="manga-bookcase-board"><div className="manga-bookcase-spines">
    {manga.volumes.map(volume => <Spine key={volume.id} volume={volume} latest={volume.volumeNumber === manga.latestKoreanVolume} picked={manga.activeVolumeId === volume.id} privacy={privacy} stripWidth={stripWidth} focus={manga.focuses.find(focus => focus.volumeId === volume.id && focus.coverArtworkId === volume.coverArtworkId)?.focusX ?? null} owned={manga.ownedNumbers === null ? null : manga.ownedNumbers.includes(volume.volumeNumber)} onPick={() => onPick(volume.id)} onEnlarge={onEnlarge} />)}
    {!manga.volumes.length && <span className="manga-cover-empty">이 판본의 표지가 없습니다.</span>}
  </div></div></div>;
}
function Spine({ volume, latest, picked, privacy, focus, owned, stripWidth, onPick, onEnlarge }: { volume: CollectionVolume; latest: boolean; picked: boolean; privacy: boolean; focus: number | null; owned: boolean | null; stripWidth: number; onPick(): void; onEnlarge?(): void }) {
  const [ratio, setRatio] = useState(.71);
  const full = 120 * ratio;
  const src = volume.coverArtworkId ? workArtworkThumbnailUrl(volume.coverArtworkId) : null;
  const missing = owned === false;
  const image = (front: boolean) => !privacy && src ? <StableImage src={src} alt="" draggable={false} onLoad={event => { if (event.currentTarget.naturalHeight) setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight); }} style={front ? undefined : { objectPosition: `${stripPosition(focus, full, stripWidth)}% 50%` }} /> : <span className="manga-spine-empty" aria-hidden="true" />;
  return <button type="button" className={`manga-spine${missing ? " manga-spine--missing" : ""}${volume.releaseStatus === "upcoming" ? " manga-spine--upcoming" : ""}`} aria-label={`${volumeLabel(volume)} 보기`} aria-description={volume.releaseStatus === "upcoming" ? `${volume.localReleaseDate ?? ""} 출간 예정` : missing ? "미보유" : undefined} aria-pressed={picked} onClick={onPick} onDoubleClick={onEnlarge} style={{ "--spine-width": `${stripWidth}px`, "--cover-width": `${full}px` } as CSSProperties}>
    {/* The shelf is a physical object: real cover strip, light only, no invented printing. */}
    {latest && <span className="manga-latest-label">최신</span>}
    <span className="manga-spine-strip" style={picked ? { visibility: "hidden" } : undefined}>{image(false)}<span className="manga-spine-number">{volume.volumeNumber}</span></span>
    {picked && <span className="manga-spine-front">{image(true)}</span>}
    {picked && <span className="manga-picked-number">{volume.volumeNumber}</span>}
    {missing && volume.releaseStatus === "upcoming" && !picked && <span className="manga-upcoming-date">{volume.localReleaseDate?.slice(5).replace("-", ".")}</span>}
  </button>;
}
