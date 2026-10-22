import { WorkZoomObject, WorkZoomStage } from "./WorkZoom";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { displayDate } from "../../shared/displayDate";
import type { CollectionVolume, CollectionCoverFocus } from "../../library/types";
import { mangaSpineScanUrl, workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { StableImage } from "../../shared/ui/StableImage";
import { ShelfScroller } from "../../shared/ui/ShelfScroller";
import { useWorkImageReady } from "./useWorkImageReady";
import { MangaBook } from "./MangaBook";
import { stripPosition } from "./coverStrip";
import { volumeLabel } from "../collectionFormat";
import { ShelfMaterial } from "../ShelfMaterial";
import { mangaPixels, MANGA_MM, MANGA_PX_PER_MM, mangaShelfStyle, mangaVolumeHash, mangaScanWidth } from "../mangaDimensions";
import { mangaSpineColor, sampleMangaSpineColor } from "./mangaSpineColor";
import { LONG_PRESS_MS } from "../../shared/useLongPress";

export type MangaWorkData = { volumes: CollectionVolume[]; activeVolumeId: string | null; editionIndex: number; latestKoreanVolume?: number | null; focuses: CollectionCoverFocus[]; ownedNumbers: number[] | null; scope: string; revision: string; ownership: ReactNode; management: ReactNode };
export function editionName(index: number) { return index === 0 ? "기본판" : `대체판 ${index}`; }
/** `coverUrl` resolves a volume cover's full image; each client passes its own (default: the PC's local artwork). */
export function MangaStage({ manga, privacy, title, author, frontReset, coverUrl = workArtworkUrl, onPick, onReady }: { manga: MangaWorkData; privacy: boolean; title: string; author: string | null; frontReset: number; coverUrl?(artworkId: string): string | null; onPick(id: string): void; onReady(): void }) {
  const active = manga.volumes.find(volume => volume.id === manga.activeVolumeId);
  const index = manga.volumes.findIndex(volume => volume.id === active?.id);
  const src = active?.coverArtworkId ? coverUrl(active.coverArtworkId) : null;
  const focus = manga.focuses.find(item => item.volumeId === active?.id && item.coverArtworkId === active?.coverArtworkId)?.focusX ?? null;
  return <WorkZoomStage className="work-stage manga-work-stage">
    <WorkZoomObject>
    <MangaBook src={src} title={title} author={author} volumeNumber={active?.volumeNumber ?? null} volumeTitle={active ? volumeLabel(active) : ""} isbn13={active?.isbn13} localReleaseDate={active?.localReleaseDate} contents={active?.contents} price={active?.price} publisher={active?.publisher} focus={focus} privacy={privacy} frontReset={frontReset} onReady={onReady} />
    </WorkZoomObject>
    {/* Wide edges belong to the immersive work viewer, separate from ownership controls. */}
    <button className="asset-viewer__edge asset-viewer__edge--left" aria-label="이전 권" disabled={index <= 0} onClick={() => onPick(manga.volumes[index - 1].id)}><ChevronLeftIcon /></button>
    <button className="asset-viewer__edge asset-viewer__edge--right" aria-label="다음 권" disabled={index < 0 || index >= manga.volumes.length - 1} onClick={() => onPick(manga.volumes[index + 1].id)}><ChevronRightIcon /></button>
  </WorkZoomStage>;
}
/** Keep this much shelf beside the current volume when scrolling it into view. */
const SCROLL_MARGIN = 64;
/**
 * `coverUrl` resolves a volume cover's thumbnail; each client passes its own (default: the PC's local artwork).
 * `list`: the Collections list row — the same books and plank, left-aligned under the row's label.
 */
export function MangaBookcase({ manga, privacy, coverUrl = workArtworkThumbnailUrl, list = false, touchTargets = false, label = "권별 책장", title = "", author = null, publisher = null, onPick, onEnlarge, onReady }: { manga: MangaWorkData; privacy: boolean; coverUrl?(artworkId: string): string | null; list?: boolean; touchTargets?: boolean; label?: string; title?: string; author?: string | null; publisher?: string | null; onPick(id: string): void; onEnlarge?(volumeId: string): void; onReady?(): void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const firstOwned = manga.volumes.find(volume => manga.ownedNumbers === null || manga.ownedNumbers.includes(volume.volumeNumber));
  const scanVolume = !touchTargets && !privacy ? manga.volumes.find(volume => volume.spineScan?.side) : undefined;
  const colorKey = scanVolume?.spineScan?.side ?? JSON.stringify([firstOwned?.id, firstOwned?.coverArtworkId]);
  const [sample, setSample] = useState<{ key: string; ink: string } | null>(null);
  const ink = sample?.key === colorKey ? sample.ink : (!touchTargets ? sample?.ink : null) ?? mangaSpineColor(colorKey);
  const sampleCover = (image: HTMLImageElement) => setSample({ key: colorKey, ink: sampleMangaSpineColor(colorKey, image) });
  const sources = Object.fromEntries(manga.volumes.flatMap(volume => {
    const src = !privacy && volume.coverArtworkId ? coverUrl(volume.coverArtworkId) : null;
    return [[`${volume.id}:strip`, src], ...(volume.id === manga.activeVolumeId ? [[`${volume.id}:front`, src]] : [])];
  }));
  const images = useWorkImageReady(sources, onReady);
  // Ownership can change while the first owned cover is already mounted and decoded.
  useEffect(() => {
    if (privacy || scanVolume) return;
    const button = [...viewport.current?.querySelectorAll<HTMLButtonElement>("[data-volume-id]") ?? []].find(element => element.dataset.volumeId === firstOwned?.id);
    const image = button?.querySelector<HTMLImageElement>(".manga-print-art img");
    if (image?.complete && image.naturalWidth) setSample({ key: colorKey, ink: sampleMangaSpineColor(colorKey, image) });
  }, [colorKey, privacy, firstOwned?.id, scanVolume]);
  // Tablet taps use the whole book area; native scrolling keeps ownership of swipes.
  const tap = useRef<{ id: number; x: number; y: number; left: number; track: HTMLElement; moved: boolean; time: number } | null>(null);
  const suppressClick = useRef(false);
  const moved = (event: PointerEvent<HTMLDivElement>) => {
    const start = tap.current;
    if (start && start.id === event.pointerId && (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8 || start.track.scrollLeft !== start.left)) start.moved = true;
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Both list and detail use the nearest book; native swipes still scroll.
    if (!touchTargets || event.button !== 0 || event.isPrimary === false) return;
    suppressClick.current = false;
    const track = (event.target as HTMLElement).closest<HTMLElement>(".home-shelf__track");
    if (!track) return;
    suppressClick.current = true;
    tap.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: track.scrollLeft, track, moved: false, time: Date.now() };
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    moved(event);
    const start = tap.current;
    tap.current = null;
    if (!start || start.id !== event.pointerId || start.moved) return;
    // A list-row hold opens its action sheet; releasing it must not also pick a book.
    if (list && Date.now() - start.time >= LONG_PRESS_MS) return;
    const spines = [...start.track.querySelectorAll<HTMLButtonElement>("[data-volume-id]")];
    let nearest: HTMLButtonElement | null = null, distance = Infinity;
    for (const spine of spines) {
      const box = spine.getBoundingClientRect();
      const next = Math.abs(event.clientX - (box.left + box.width / 2));
      if (next < distance) { nearest = spine; distance = next; }
    }
    if (nearest?.dataset.volumeId) onPick(nearest.dataset.volumeId);
  };
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
  return <div ref={viewport} style={mangaShelfStyle(touchTargets)} onPointerDown={pointerDown} onPointerMove={touchTargets ? moved : undefined} onPointerUp={touchTargets ? pointerUp : undefined}
    onScrollCapture={touchTargets ? () => { if (tap.current) tap.current.moved = true; } : undefined}
    onPointerCancel={touchTargets ? () => { tap.current = null; } : undefined}
    onClickCapture={touchTargets ? event => { if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); } suppressClick.current = false; } : undefined} className={list ? "manga-bookcase manga-bookcase--list" : "work-strip manga-bookcase"} role="group" aria-label={label}><ShelfScroller previousLabel="책장 왼쪽 보기" nextLabel="책장 오른쪽 보기"><div className="manga-bookcase-board"><div className="manga-bookcase-spines">
    {manga.volumes.map(volume => <Spine key={volume.id} title={title} author={author} publisher={volume.publisher ?? publisher} ink={ink} tablet={touchTargets} onSample={!scanVolume && volume.id === firstOwned?.id ? sampleCover : undefined} onScanSample={volume.id === scanVolume?.id ? sampleCover : undefined} onImageLoad={(front, event) => void images.loaded(`${volume.id}:${front ? "front" : "strip"}`, event)} onImageError={(front, src) => images.failed(`${volume.id}:${front ? "front" : "strip"}`, src)} volume={volume} latest={volume.volumeNumber === manga.latestKoreanVolume} picked={manga.activeVolumeId === volume.id} privacy={privacy} focus={manga.focuses.find(focus => focus.volumeId === volume.id && focus.coverArtworkId === volume.coverArtworkId)?.focusX ?? null} owned={manga.ownedNumbers === null ? null : manga.ownedNumbers.includes(volume.volumeNumber)} src={volume.coverArtworkId ? coverUrl(volume.coverArtworkId) : null} onPick={() => onPick(volume.id)} onEnlarge={onEnlarge && (() => onEnlarge(volume.id))} />)}
    {!manga.volumes.length && <span className="manga-cover-empty">이 판본의 표지가 없습니다.</span>}
  </div><ShelfMaterial /></div></ShelfScroller></div>;
}
// The PC media protocol grants CORS to the app origin only when asked, so the series colour can be sampled.
const appMedia = (src: string) => src.startsWith("http://lakomics.localhost/") || src.startsWith("lakomics://");
function Spine({ title, author, publisher, ink, tablet, onSample, onScanSample, volume, latest, picked, privacy, focus, owned, src, onPick, onEnlarge, onImageLoad, onImageError }: { title: string; author: string | null; publisher: string | null; ink: string; tablet: boolean; onSample?(image: HTMLImageElement): void; onScanSample?(image: HTMLImageElement): void; volume: CollectionVolume; latest: boolean; picked: boolean; privacy: boolean; focus: number | null; owned: boolean | null; src: string | null; onPick(): void; onEnlarge?(): void; onImageLoad(front: boolean, event: import("react").SyntheticEvent<HTMLImageElement>): void; onImageError(front: boolean, src: string): void }) {
  const size = mangaPixels(volume.id, MANGA_PX_PER_MM[tablet ? "tablet" : "pc"]);
  // Print sizes follow the nominal thickness, so one run shows the same text on every volume.
  const print = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"];
  const sideSrc = !tablet && !privacy && volume.spineScan?.side ? mangaSpineScanUrl(volume.spineScan.side) : null;
  const backSrc = !tablet && !privacy && volume.spineScan?.back ? mangaSpineScanUrl(volume.spineScan.back) : null;
  const [scan, setScan] = useState<{ src: string; ratio: number } | null>(null);
  const [backReady, setBackReady] = useState<string | null>(null);
  const [backRequested, setBackRequested] = useState(false);
  const scanned = Boolean(sideSrc && scan?.src === sideSrc);
  const spineWidth = scanned ? mangaScanWidth(size.height, scan!.ratio) : size.spine;
  const backShown = Boolean(picked && backSrc && backReady === backSrc && backRequested);
  useEffect(() => { if (!picked || privacy) setBackRequested(false); }, [picked, privacy]);
  const [artRatio, setArtRatio] = useState(128 / 182);
  const latin = !/[\u1100-\u11ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(title);
  const titleHeight = size.height * .73 - print * 4.95;
  const titleLength = latin ? title.length * .74 : Array.from(title.trim()).length * 1.22;
  const titleFont = Math.max(4, Math.min(print * .66, titleHeight / Math.max(1, titleLength) * .92));
  const labelLength = Array.from(publisher ?? "").reduce((length, character) => length + (/[\u1100-\u11ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(character) ? 1 : .65), 0);
  const labelFont = Math.min(print * .34, print * .95 / Math.max(1, labelLength));
  const authorFont = Math.min(print * .32, size.height * .1 / Math.max(1, author?.length ?? 0));
  const publisherFont = Math.min(print * .3, print * 1.2 / Math.max(1, publisher?.length ?? 0));
  // Admit a front only when picked, then retain it through put-down. The strip remains
  // visible until that front loads; StableImage retains decoded covers on refresh.
  const [frontMounted, setFrontMounted] = useState(picked);
  const [frontReady, setFrontReady] = useState(privacy || !src);
  const [fronted, setFronted] = useState(false);
  useLayoutEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!picked) {
      setFronted(false);
      if (!frontMounted) return;
      if (reduced) { setFrontMounted(false); setFrontReady(privacy || !src); return; }
      const timer = setTimeout(() => { setFrontMounted(false); setFrontReady(privacy || !src); }, 420);
      return () => clearTimeout(timer);
    }
    setFrontMounted(true);
    if (!frontReady && !privacy && src) return;
    if (reduced) { setFronted(true); return; }
    const frame = requestAnimationFrame(() => setFronted(true));
    return () => cancelAnimationFrame(frame);
  }, [picked, frontMounted, frontReady, privacy, src]);
  const full = size.width;
  const missing = owned === false;
  const description = [
    volume.releaseStatus === "upcoming" ? `${displayDate(volume.localReleaseDate)} 출간 예정`.trim() : missing ? "미보유" : null,
    picked && backSrc ? backShown ? "뒤표지. 누르면 앞표지 보기" : "앞표지. 누르면 뒤표지 보기" : null,
  ].filter(Boolean).join(". ") || undefined;
  const image = (front: boolean) => !privacy && src ? <StableImage src={src} alt="" draggable={false} decodeFirst={!front} crossOrigin={!front && appMedia(src) ? "anonymous" : undefined} onLoad={async event => {
    const element = event.currentTarget;
    onImageLoad(front, event);
    if (!front) {
      if (element.naturalHeight) setArtRatio(element.naturalWidth / element.naturalHeight);
      onSample?.(element);
    }
    if (front) {
      try { await element.decode?.(); } catch { return; }
      if (element.isConnected && element.getAttribute("src") === src) setFrontReady(true);
    }
  }} onPreloadError={() => { onImageError(front, src); if (front) setFrontReady(true); }} onError={() => { onImageError(front, src); if (front) setFrontReady(true); }} style={front ? undefined : { objectPosition: `${stripPosition(focus, size.height * .17 * artRatio, size.spine)}% 50%` }} /> : <span className="manga-spine-empty" aria-hidden="true" />;
  return <button type="button" className={`manga-spine${sideSrc ? " manga-spine--scanned" : ""}${fronted ? " is-fronted" : ""}${frontMounted && !picked ? " is-settling" : ""}${missing ? " manga-spine--missing" : ""}${volume.releaseStatus === "upcoming" ? " manga-spine--upcoming" : ""}`} aria-label={`${volumeLabel(volume)} 보기`} aria-description={description} aria-pressed={picked} data-volume-id={volume.id} onClick={() => { if (picked && backSrc) setBackRequested(value => !value); else onPick(); }} onDoubleClick={backSrc ? undefined : onEnlarge} style={{ "--spine-width": `${spineWidth}px`, "--print-nominal": `${print}px`, "--cover-width": `${full}px`, "--spine-angle": `${Math.acos(Math.min(1, spineWidth / full)) * 180 / Math.PI}deg`, "--spine-ink": ink, "--number-mix": `${mangaVolumeHash(volume.id) % 13}%`, "--title-font": `${titleFont}px`, "--label-font": `${labelFont}px`, "--author-font": `${authorFont}px`, "--publisher-font": `${publisherFont}px` } as CSSProperties}>
    {/* Printed parts stay in place while the art and series ink arrive. */}
    {latest && <span className="manga-latest-label">최신</span>}
    <span className={`manga-spine-strip${scanned ? " manga-spine-strip--scanned" : ""}${privacy ? " manga-spine-strip--private" : ""}`} aria-hidden="true">
      {!privacy && <>
        <span className="manga-print-label"><span style={labelFont < 3 ? { visibility: "hidden" } : undefined}>{publisher}</span></span>
        <span className={`manga-print-title${latin ? " manga-print-title--latin" : ""}`}><span>{title}</span></span>
      </>}
      <span className="manga-spine-number">{volume.volumeNumber}</span>
      {!privacy && <>
        <span className="manga-print-art">{image(false)}</span>
        <span className="manga-print-author"><span style={authorFont < 3 ? { visibility: "hidden" } : undefined}>{author}</span></span>
        <span className="manga-print-publisher"><span style={publisherFont < 3 ? { visibility: "hidden" } : undefined}>{publisher}</span></span>
      </>}
      {sideSrc && <span className={`manga-scan${scanned ? " is-decoded" : ""}`}><ScanImage src={sideSrc} onDecoded={element => {
        setScan({ src: sideSrc, ratio: element.naturalWidth / element.naturalHeight });
        onScanSample?.(element);
      }} /></span>}
      <span className="collection-spine-light" />
    </span>
    {frontMounted && <span className="manga-spine-front" onTransitionEnd={event => { if (!picked && event.target === event.currentTarget && event.propertyName === "transform") { setFrontMounted(false); setFrontReady(privacy || !src); } }}>{!tablet ? <span className={`manga-spine-turn${backShown ? " is-back" : ""}`}>
      <span className="manga-spine-face">{image(true)}</span>
      {backSrc && <span className="manga-spine-face manga-spine-face--back" aria-hidden="true"><span className="manga-scan is-decoded"><ScanImage src={backSrc} onDecoded={() => setBackReady(backSrc)} /></span></span>}
    </span> : image(true)}</span>}
    {picked && <span className="manga-picked-number">{volume.volumeNumber}</span>}
    {volume.releaseStatus === "upcoming" && !picked && <span className="manga-upcoming-date">{displayDate(volume.localReleaseDate)}</span>}
  </button>;
}

/** Keep the printed fallback until the actual raster has decoded; never reveal a blank scan. */
function ScanImage({ src, onDecoded }: { src: string; onDecoded(image: HTMLImageElement): void }) {
  const latest = useRef(onDecoded); latest.current = onDecoded;
  return <img src={src} alt="" draggable={false} crossOrigin={appMedia(src) ? "anonymous" : undefined} onLoad={async event => {
    const element = event.currentTarget;
    try { await element.decode?.(); } catch { return; }
    if (element.isConnected && element.getAttribute("src") === src && element.naturalWidth && element.naturalHeight) latest.current(element);
  }} />;
}
