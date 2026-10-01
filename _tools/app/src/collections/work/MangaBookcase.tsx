import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { CollectionVolume, CollectionCoverFocus } from "../../library/types";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { StableImage } from "../../shared/ui/StableImage";
import { PaperbackLive } from "../physical/PaperbackLive";
import { volumeLabel } from "../collectionFormat";

export type MangaWorkData = { volumes: CollectionVolume[]; activeVolumeId: string | null; editionIndex: number; latestKoreanVolume?: number | null; focuses: CollectionCoverFocus[]; ownedNumbers: number[] | null; scope: string; revision: string; ownership: ReactNode; management: ReactNode };
export function editionName(index: number) { return index === 0 ? "기본판" : `대체판 ${index}`; }
// Converts the head coordinate to object-position so the strip centre, not its edge,
// lands on the head. This is the accepted prototype's cut rule, clamped at cover edges.
export function stripPosition(focus: number | null, fullWidth: number, stripWidth: number) {
  return focus === null || fullWidth <= stripWidth ? 50 : Math.max(0, Math.min(1, (focus * fullWidth - stripWidth / 2) / (fullWidth - stripWidth))) * 100;
}
export function MangaStage({ manga, privacy, live, title, onPick, onReady }: { manga: MangaWorkData; privacy: boolean; live: boolean; title: string; onPick(id: string): void; onReady(): void }) {
  const active = manga.volumes.find(volume => volume.id === manga.activeVolumeId);
  const index = manga.volumes.findIndex(volume => volume.id === active?.id);
  const [painted, setPainted] = useState<string | null>(null);
  const settled = useRef(new Set<string>());
  const ready = useRef(onReady); ready.current = onReady;
  const src = active?.coverArtworkId ? workArtworkUrl(active.coverArtworkId) : null;
  useEffect(() => { if (privacy || !src || settled.current.has(src)) ready.current(); });
  return <div className="work-stage manga-work-stage">
    <div className="manga-work-book">
      {privacy ? <span className="privacy-mask" aria-label="비공개 모드" /> : src ? <>
        <StableImage src={src} alt={`${active ? volumeLabel(active) : title} 표지`} draggable={false} style={live && painted === src ? { visibility: "hidden" } : undefined} onLoad={async event => {
          const image = event.currentTarget;
          try { await image.decode?.(); } catch { /* Failed decode settles without locking navigation. */ }
          if (image.getAttribute("src") === src) { settled.current.add(src); ready.current(); }
        }} onError={() => { settled.current.add(src); ready.current(); }} onPreloadError={() => { settled.current.add(src); ready.current(); }} />
        {live && <div className="manga-live-layer" style={painted === src ? undefined : { visibility: "hidden", pointerEvents: "none" }} aria-hidden={painted !== src}><PaperbackLive src={src} alt={`${title} ${active ? volumeLabel(active) : ""} 입체 표지`} scope={manga.scope} revision={manga.revision} frontFacing onReady={success => setPainted(success ? src : null)} /></div>}
      </> : <span className="manga-cover-empty">표지가 없습니다.</span>}
    </div>
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
