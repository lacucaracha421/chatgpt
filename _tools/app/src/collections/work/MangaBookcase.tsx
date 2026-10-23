import { createPortal } from "react-dom";
import { useBackHandler } from "../../shared/navigation/BackNavigation";
import { CollectionCase } from "../case/CollectionCase";
import { stageForCaseHeight } from "../case/fitCaseStage";
import "../SpineShelf.css";
import "./mangaPullOut.css";
import { WorkZoomObject, WorkZoomStage } from "./WorkZoom";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { displayDate } from "../../shared/displayDate";
import type { CollectionVolume, CollectionCoverFocus } from "../../library/types";
import { mangaSpineScanUrl, workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { StableImage } from "../../shared/ui/StableImage";
import { ShelfScroller } from "../../shared/ui/ShelfScroller";
import { useWorkImageReady } from "./useWorkImageReady";
import { useSpineImages } from "./useSpineImages";
import { MangaBook } from "./MangaBook";
import { stripPosition } from "./coverStrip";
import { volumeLabel } from "../collectionFormat";
import { ShelfMaterial } from "../ShelfMaterial";
import { mangaPixels, MANGA_MM, MANGA_PX_PER_MM, mangaShelfStyle, mangaVolumeHash, mangaScanWidth } from "../mangaDimensions";
import { mangaSpineColor, sampleMangaSpineColor, useMangaSpineInk } from "./mangaSpineColor";
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
function useShelfBack(handler: () => void, enabled: boolean) { useBackHandler(handler, 80, enabled); }
export type MangaShelfBack = (handler: () => void, enabled: boolean) => void;
/**
 * `coverUrl` resolves a volume cover's thumbnail; each client passes its own (default: the PC's local artwork).
 * `list`: the Collections list row — the same books and plank, left-aligned under the row's label.
 */
/** Android WebView text zoom (system or 글자 크기) enlarges every font; spine print must stay sized to the book. */
function printZoom(): number {
  try {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:400 100px sans-serif";
    probe.textContent = "가나다라마바사아";
    document.body.appendChild(probe);
    const shown = probe.getBoundingClientRect().width;
    probe.remove();
    const context = document.createElement("canvas").getContext("2d");
    if (!context || !shown) return 1;
    context.font = "400 100px sans-serif";
    const ratio = shown / context.measureText("가나다라마바사아").width;
    return Number.isFinite(ratio) && Math.abs(ratio - 1) > .03 ? Math.min(2, Math.max(.5, 1 / ratio)) : 1;
  } catch { return 1; }
}
export function MangaBookcase({ manga, privacy, coverUrl = workArtworkThumbnailUrl, list = false, touchTargets = false, label = "권별 책장", title = "", author = null, publisher = null, onPick, onEnlarge, onReady, onPull, pullPending = false, useBack = useShelfBack, range, seriesKey, seriesScan = false }: { seriesScan?: boolean; seriesKey?: string; range?: { start: number; count: number }; pullPending?: boolean; onPull?(id: string): void; useBack?: MangaShelfBack; manga: MangaWorkData; privacy: boolean; coverUrl?(artworkId: string): string | null; list?: boolean; touchTargets?: boolean; label?: string; title?: string; author?: string | null; publisher?: string | null; onPick(id: string): void; onEnlarge?(volumeId: string): void; onReady?(): void }) {
  const volumes = useMemo(() => range ? manga.volumes.slice(range.start, range.start + range.count) : manga.volumes, [manga.volumes, range?.start, range?.count]);
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom] = useState(printZoom);
  const [out, setOut] = useState<{ id: string; leaving: boolean } | null>(null);
  const [painted, setPainted] = useState(false);
  const pendingPick = useRef<string | null>(null);
  const keyboardPick = useRef(false);
  const dismiss = (clearPending = true) => {
    if (clearPending) { pendingPick.current = null; keyboardPick.current = false; }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !painted) { setOut(null); setPainted(false); }
    else setOut(value => value && !value.leaving ? { ...value, leaving: true } : value);
  };
  useBack(dismiss, Boolean(out && !out.leaving));
  const choose = (id: string) => {
    // The work screen's bookcase is a volume picker: a click switches to that volume at once.
    if (!list) { onPick(id); return; }
    if (out?.id === id && !out.leaving) {
      if (keyboardPick.current && painted) {
        keyboardPick.current = false;
        document.querySelector<HTMLElement>(".manga-shelf-out:not(.is-leaving) .kase")?.focus({preventScroll: true});
      }
      return;
    }
    if (out && painted && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      pendingPick.current = id; dismiss(false); return;
    }
    window.dispatchEvent(new CustomEvent("manga-shelf-pick", { detail: viewport.current }));
    setPainted(false); setOut({ id, leaving: false });
    onPull?.(id);
    if (list) onPick(id);
  };
  useEffect(() => {
    if (!out) return;
    if (out.leaving) {
      const timer = setTimeout(() => {
        const next = pendingPick.current; pendingPick.current = null;
        setPainted(false); setOut(next ? { id: next, leaving: false } : null);
        if (next) { onPull?.(next); if (list) onPick(next); }
      }, 440);
      return () => clearTimeout(timer);
    }
  }, [out]);
  useEffect(() => {
    if (!out) return;
    const elsewhere = (event: Event) => {
      const target = event.target as Element;
      if (target.closest?.(".manga-shelf-out") || viewport.current?.contains(target)) return;
      dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); dismiss();
      [...viewport.current?.querySelectorAll<HTMLButtonElement>("[data-volume-id]") ?? []].find(node => node.dataset.volumeId === out.id)?.focus({ preventScroll: true });
    };
    const otherPick = (event: Event) => { if ((event as CustomEvent).detail !== viewport.current) { pendingPick.current = null; dismiss(); } };
    document.addEventListener("click", elsewhere);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("manga-shelf-pick", otherPick);
    return () => { document.removeEventListener("click", elsewhere); window.removeEventListener("keydown", escape, true); window.removeEventListener("manga-shelf-pick", otherPick); };
  }, [out, painted]);
  useEffect(() => { if (out && !manga.volumes.some(volume => volume.id === out.id)) { setOut(null); setPainted(false); } }, [manga.volumes, out]);
  const previousSelection = useRef(manga.activeVolumeId);
  useEffect(() => {
    const changed = previousSelection.current !== manga.activeVolumeId;
    previousSelection.current = manga.activeVolumeId;
    if (list && changed && out && manga.activeVolumeId !== out.id) dismiss();
  }, [manga.activeVolumeId]);
  const ownedNumbers = useMemo(() => manga.ownedNumbers === null ? null : new Set(manga.ownedNumbers), [manga.ownedNumbers]);
  const focuses = useMemo(() => {
    const covers = new Map(manga.volumes.map(volume => [volume.id, volume.coverArtworkId]));
    const result = new Map<string, number | null>();
    for (const focus of manga.focuses) {
      if (!result.has(focus.volumeId) && covers.get(focus.volumeId) === focus.coverArtworkId) result.set(focus.volumeId, focus.focusX);
    }
    return result;
  }, [manga.volumes, manga.focuses]);
  const firstOwned = manga.volumes.find(volume => ownedNumbers === null || ownedNumbers.has(volume.volumeNumber));
  const scanVolume = !privacy ? manga.volumes.find(volume => volume.spineScan?.side) : undefined;
  const colorKey = seriesKey ?? scanVolume?.spineScan?.side ?? JSON.stringify([firstOwned?.id, firstOwned?.coverArtworkId]);
  const sharedInk = useMangaSpineInk(colorKey);
  const [sample, setSample] = useState<{ key: string; ink: string } | null>(null);
  const ink = sharedInk ?? (sample?.key === colorKey ? sample.ink : (!touchTargets ? sample?.ink : null) ?? mangaSpineColor(colorKey));
  const sampleCover = useCallback((image: HTMLImageElement) => setSample({ key: colorKey, ink: sampleMangaSpineColor(colorKey, image) }), [colorKey]);
  // Ownership can change while the first owned cover is already mounted and decoded.
  useEffect(() => {
    if (privacy || scanVolume || seriesScan) return;
    const button = [...viewport.current?.querySelectorAll<HTMLButtonElement>("[data-volume-id]") ?? []].find(element => element.dataset.volumeId === firstOwned?.id);
    const image = button?.querySelector<HTMLImageElement>(".manga-print-art img");
    if (image?.complete && image.naturalWidth) setSample({ key: colorKey, ink: sampleMangaSpineColor(colorKey, image) });
  }, [colorKey, privacy, firstOwned?.id, scanVolume, seriesScan]);
  // Tablet taps use the whole book area; native scrolling keeps ownership of swipes.
  const tap = useRef<{ id: number; x: number; y: number; left: number; track: HTMLElement; moved: boolean; time: number } | null>(null);
  const suppressClick = useRef(false);
  const moved = (event: PointerEvent<HTMLDivElement>) => {
    const start = tap.current;
    if (start && start.id === event.pointerId && (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8 || start.track.scrollLeft !== start.left)) start.moved = true;
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Both list and detail use the nearest book; native swipes still scroll.
    if ((event.target as Element).closest(".manga-shelf-out")) return;
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
    // The empty wall beside a run is not a book: only a tap on or right next to a spine picks one.
    const reach = Math.max(24, nearest ? nearest.getBoundingClientRect().width : 0);
    if (distance <= reach) nearest?.click();
    suppressClick.current = true;
  };
  const placed = useRef(false);
  // Scroll only the shelf (never the page) so the current volume stays in view; centred shelves do not move.
  useLayoutEffect(() => {
    if (list) return;
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
  const { requested, measured } = useSpineImages(viewport, !list, volumes, scanVolume?.id ?? firstOwned?.id);
  const covers = useMemo(() => new Map(volumes.map(volume => [volume.id, volume.coverArtworkId ? coverUrl(volume.coverArtworkId) : null])), [volumes, coverUrl]);
  // The colour source is eager even when it is outside the strip's opening viewport.
  const needsImage = (id: string) => requested === null || requested.has(id) || id === (scanVolume?.id ?? firstOwned?.id);
  const sources = Object.fromEntries(volumes.filter(volume => needsImage(volume.id)).map(volume => [`${volume.id}:strip`, privacy ? null : covers.get(volume.id) ?? null]));
  const images = useWorkImageReady(sources, onReady && measured ? onReady : undefined);
  // Event identities stay fixed while selection and parent callbacks change.
  const handlers = useRef({ choose, onEnlarge }); handlers.current = { choose, onEnlarge };
  const pickSpine = useCallback((id: string) => handlers.current.choose(id), []);
  const enlargeSpine = useCallback((id: string) => {
    setOut(null); setPainted(false); handlers.current.onEnlarge?.(id);
  }, []);
  const outVolume = manga.volumes.find(volume => volume.id === out?.id);
  const books = <div className="manga-bookcase-board" style={zoom === 1 ? undefined : { "--print-zoom": zoom } as CSSProperties}><div className="manga-bookcase-spines">
    {volumes.map(volume => <Spine key={volume.id} title={title} author={author} publisher={volume.publisher ?? publisher} ink={ink} tablet={touchTargets} onSample={!scanVolume && !seriesScan && volume.id === firstOwned?.id ? sampleCover : undefined} onScanSample={volume.id === scanVolume?.id ? sampleCover : undefined} onImageLoad={onReady ? images.loaded : undefined} onImageError={onReady ? images.failed : undefined} volume={volume} latest={volume.volumeNumber === manga.latestKoreanVolume} out={out?.id === volume.id && painted} picked={manga.activeVolumeId === volume.id} privacy={privacy} focus={focuses.get(volume.id) ?? null} owned={ownedNumbers === null ? null : ownedNumbers.has(volume.volumeNumber)} src={covers.get(volume.id) ?? null} loadImages={needsImage(volume.id)} onPick={pickSpine} onEnlarge={onEnlarge ? enlargeSpine : undefined} />)}
    {!manga.volumes.length && <span className="manga-cover-empty">이 판본의 표지가 없습니다.</span>}
  </div>{!list && <ShelfMaterial />}</div>;
  return <div ref={viewport} onKeyDown={event => {
    const spine = (event.target as Element).closest<HTMLElement>("button[data-volume-id]");
    if (!spine || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault(); event.stopPropagation(); keyboardPick.current = true;
    choose(spine.dataset.volumeId!);
  }} style={mangaShelfStyle(touchTargets)} onPointerDown={pointerDown} onPointerMove={touchTargets ? moved : undefined} onPointerUp={touchTargets ? pointerUp : undefined}
    onScrollCapture={touchTargets ? () => { if (tap.current) tap.current.moved = true; } : undefined}
    onPointerCancel={touchTargets ? () => { tap.current = null; } : undefined}
    onClickCapture={touchTargets ? event => { if (!(event.target as Element).closest(".manga-shelf-out") && suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); } suppressClick.current = false; } : undefined} onClick={event => { if (!touchTargets && !(event.target as Element).closest("button, .manga-shelf-out")) dismiss(); }} className={list ? "manga-bookcase manga-bookcase--list" : "work-strip manga-bookcase"} role="group" aria-label={label}>
    {list ? <div className="home-shelf__track manga-shelf-run__track">{books}</div> : <ShelfScroller releaseAtEdges previousLabel="책장 왼쪽 보기" nextLabel="책장 오른쪽 보기">{books}</ShelfScroller>}
    {out && outVolume && <MangaPullOut pending={pullPending} key={out.id} volume={outVolume} viewport={viewport} privacy={privacy} src={outVolume.coverArtworkId ? coverUrl(outVolume.coverArtworkId) : null} title={title} author={author} publisher={publisher} ink={ink} tablet={touchTargets} zoom={zoom} focus={manga.focuses.find(item => item.volumeId === out.id && item.coverArtworkId === outVolume.coverArtworkId)?.focusX ?? null} owned={manga.ownedNumbers === null ? null : manga.ownedNumbers.includes(outVolume.volumeNumber)} leaving={out.leaving} onPaint={() => {
      setPainted(true);
      if (keyboardPick.current && !out.leaving) {
        keyboardPick.current = false;
        document.querySelector<HTMLElement>(".manga-shelf-out:not(.is-leaving) .kase")?.focus({preventScroll: true});
      }
    }} onOpen={() => { setOut(null); setPainted(false); if (list && onEnlarge) onEnlarge(out.id); else onPick(out.id); }} />}
  </div>;
}
// The PC media protocol grants CORS to the app origin only when asked, so the series colour can be sampled.
const appMedia = (src: string) => src.startsWith("http://lakomics.localhost/") || src.startsWith("lakomics://");
const Spine = memo(function Spine({ title, author, publisher, ink, tablet, onSample, onScanSample, volume, latest, picked, privacy, focus, owned, src, onPick, onEnlarge, onImageLoad, onImageError, loadImages = true, out = false, decorative = false }: { loadImages?: boolean; out?: boolean; decorative?: boolean; title: string; author: string | null; publisher: string | null; ink: string; tablet: boolean; onSample?(image: HTMLImageElement): void; onScanSample?(image: HTMLImageElement): void; volume: CollectionVolume; latest: boolean; picked: boolean; privacy: boolean; focus: number | null; owned: boolean | null; src: string | null; onPick(id: string): void; onEnlarge?(id: string): void; onImageLoad?(key: string, event: import("react").SyntheticEvent<HTMLImageElement>): void; onImageError?(key: string, src: string): void }) {
  const size = mangaPixels(volume.id, MANGA_PX_PER_MM[tablet ? "tablet" : "pc"]);
  // Print sizes follow the nominal thickness, so one run shows the same text on every volume.
  const print = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"];
  const sideSrc = !privacy && volume.spineScan?.side ? mangaSpineScanUrl(volume.spineScan.side) : null;
  const [scan, setScan] = useState<{ src: string; ratio: number } | null>(null);
  const scanned = Boolean(sideSrc && scan?.src === sideSrc);
  const spineWidth = scanned ? mangaScanWidth(size.height, scan!.ratio) : size.spine;
  const [artRatio, setArtRatio] = useState(128 / 182);
  const latin = !/[\u1100-\u11ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(title);
  const titleHeight = size.height * .73 - print * 4.95;
  const titleLength = latin ? title.length * .74 : Array.from(title.trim()).length * 1.22;
  const titleFont = Math.min(print * .66, titleHeight / Math.max(1, titleLength) * .92);
  const labelLength = Array.from(publisher ?? "").reduce((length, character) => length + (/[\u1100-\u11ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(character) ? 1 : .65), 0);
  const labelFont = Math.min(print * .34, print * .95 / Math.max(1, labelLength));
  const authorFont = Math.min(print * .32, size.height * .1 / Math.max(1, Array.from(author ?? "").length * 1.22));
  const publisherFont = Math.min(print * .3, print * 1.2 / Math.max(1, Array.from(publisher ?? "").length * 1.22));
  const missing = owned === false;
  const description = [
    volume.releaseStatus === "upcoming" ? `${displayDate(volume.localReleaseDate)} 출간 예정`.trim() : missing ? "미보유" : null,
  ].filter(Boolean).join(". ") || undefined;
  const image = !privacy && src && loadImages ? <StableImage src={src} alt="" draggable={false} decodeFirst crossOrigin={appMedia(src) ? "anonymous" : undefined} onLoad={event => {
    const element = event.currentTarget;
    onImageLoad?.(`${volume.id}:strip`, event);
    if (element.naturalHeight) setArtRatio(element.naturalWidth / element.naturalHeight);
    onSample?.(element);
  }} onPreloadError={() => onImageError?.(`${volume.id}:strip`, src)} onError={() => onImageError?.(`${volume.id}:strip`, src)} style={{ objectPosition: `${stripPosition(focus, size.height * .17 * artRatio, size.spine)}% 50%` }} /> : <span className="manga-spine-empty" aria-hidden="true" />;
  const Tag = decorative ? "span" : "button";
  return <Tag type={decorative ? undefined : "button"} className={`manga-spine${sideSrc ? " manga-spine--scanned" : ""}${missing ? " manga-spine--missing" : ""}${volume.releaseStatus === "upcoming" ? " manga-spine--upcoming" : ""}`} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : `${volumeLabel(volume)} 보기`} aria-description={description} aria-pressed={picked} data-volume-id={decorative ? undefined : volume.id} data-out={out || undefined} onClick={decorative ? undefined : () => onPick(volume.id)} onDoubleClick={decorative || !onEnlarge ? undefined : () => onEnlarge(volume.id)} style={{ "--spine-width": `${spineWidth}px`, "--print-nominal": `${print}px`, "--spine-ink": ink, "--number-mix": `${mangaVolumeHash(volume.id) % 13}%`, "--title-font": `${titleFont}px`, "--label-font": `${labelFont}px`, "--author-font": `${authorFont}px`, "--publisher-font": `${publisherFont}px` } as CSSProperties}>
    {/* Printed parts stay in place while the art and series ink arrive. */}
    {latest && !decorative && <span className="manga-latest-label">최신</span>}
    <span className={`manga-spine-strip${scanned ? " manga-spine-strip--scanned" : ""}${privacy ? " manga-spine-strip--private" : ""}`} aria-hidden="true">
      {!privacy && <>
        <span className="manga-print-label"><span>{publisher}</span></span>
        <span className={`manga-print-title${latin ? " manga-print-title--latin" : ""}`}><span>{title}</span></span>
      </>}
      <span className="manga-spine-number">{volume.volumeNumber}</span>
      {!privacy && <>
        <span className="manga-print-art">{image}</span>
        <span className="manga-print-author"><span style={authorFont < 3 ? { visibility: "hidden" } : undefined}>{author}</span></span>
        <span className="manga-print-publisher"><span style={publisherFont < 3 ? { visibility: "hidden" } : undefined}>{publisher}</span></span>
      </>}
      {/* Scan aspect ratios determine shelf geometry, so scans keep loading eagerly. */}
      {sideSrc && <span className={`manga-scan${scanned ? " is-decoded" : ""}`}><ScanImage src={sideSrc} onDecoded={element => {
        setScan({ src: sideSrc, ratio: element.naturalWidth / element.naturalHeight });
        onScanSample?.(element);
      }} /></span>}
      <span className="collection-spine-light" />
    </span>
    {picked && !decorative && <span className="manga-picked-number">{volume.volumeNumber}</span>}
    {volume.releaseStatus === "upcoming" && !picked && !decorative && <span className="manga-upcoming-date">{displayDate(volume.localReleaseDate)}</span>}
  </Tag>;
});

/** Keep the printed fallback until the actual raster has decoded; never reveal a blank scan. */
function ScanImage({ src, onDecoded }: { src: string; onDecoded(image: HTMLImageElement): void }) {
  const latest = useRef(onDecoded); latest.current = onDecoded;
  return <img src={src} alt="" draggable={false} crossOrigin={appMedia(src) ? "anonymous" : undefined} onLoad={async event => {
    const element = event.currentTarget;
    try { await element.decode?.(); } catch { return; }
    if (element.isConnected && element.getAttribute("src") === src && element.naturalWidth && element.naturalHeight) latest.current(element);
  }} />;
}

/** The case shelf's animation and rotation host, with paperback faces and the shelf's own print. */
function MangaPullOut({ volume, viewport, privacy, src, title, author, publisher, ink, tablet, zoom, focus, owned, leaving, pending, onPaint, onOpen }: {
  volume: CollectionVolume; viewport: RefObject<HTMLDivElement | null>; privacy: boolean; src: string | null;
  title: string; author: string | null; publisher: string | null; ink: string; tablet: boolean; zoom: number;
  focus: number | null; owned: boolean | null; leaving: boolean; pending: boolean; onPaint(): void; onOpen(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [pose, setPose] = useState<{ left: number; top: number; width: number; height: number; depth: number; from: string } | null>(null);
  const [painted, setPainted] = useState(Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
  const faceKey = JSON.stringify([privacy, src, volume.spineScan?.back]);
  const [facesReady, setFacesReady] = useState<string | null>(null);
  const side = privacy ? null : volume.spineScan?.side;
  const [paintedSide, setPaintedSide] = useState<string | null>(null);
  const spineReady = !side || paintedSide === side;
  const [pulled, setPulled] = useState(false);
  const size = mangaPixels(volume.id, MANGA_PX_PER_MM[tablet ? "tablet" : "pc"]);
  useLayoutEffect(() => {
    const measure = () => {
      const spine = [...viewport.current?.querySelectorAll<HTMLElement>("button[data-volume-id]") ?? []].find(node => node.dataset.volumeId === volume.id);
      if (!spine || !viewport.current) return;
      const box = spine.getBoundingClientRect(), shelf = (viewport.current.closest(".manga-shelf-row") ?? viewport.current).getBoundingClientRect();
      const h = box.height || size.height, depth = box.width || size.spine;
      const height = Math.round(h * 1.28), width = Math.round(height * size.width / size.height);
      const center = box.left + depth / 2;
      const left = Math.max(Math.max(0, shelf.left), Math.min((shelf.right || window.innerWidth) - width, center - width / 2));
      // Match the case shelf's perspective compensation, keeping the edge on its original slot.
      const near = 2200 / (2200 - width / 2), scale = h / height / near;
      const dx = center - left - width / 2, dy = 12 - scale * height * (near - 1) / 2;
      setPose({ left, top: box.bottom - 12 - height, width, height, depth: 520 * depth / h,
        from: `translate(${dx.toFixed(2)}px, calc(${dy.toFixed(2)}px + var(--start-lift, 0px))) scale(${scale.toFixed(4)})` });
    };
    measure();
    window.addEventListener("scroll", measure, true); window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (viewport.current) {
      observer?.observe(viewport.current);
      const spine = [...viewport.current.querySelectorAll<HTMLElement>("button[data-volume-id]")].find(node => node.dataset.volumeId === volume.id);
      if (spine) observer?.observe(spine);
    }
    return () => { window.removeEventListener("scroll", measure, true); window.removeEventListener("resize", measure); observer?.disconnect(); };
  }, [volume.id, volume.spineScan?.side, viewport, size.height, size.spine, size.width]);
  useEffect(() => {
    const timer = setTimeout(() => setPainted(true), 350);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => { if (!pending && facesReady === faceKey && spineReady) setPainted(true); }, [pending, facesReady, faceKey, spineReady]);
  useLayoutEffect(() => { if (painted && host.current) onPaint(); }, [painted, pose, onPaint]);
  useLayoutEffect(() => {
    if (!leaving) return;
    const angle = Number(host.current?.querySelector<HTMLElement>(".kase")?.dataset.angle ?? 28);
    host.current?.style.setProperty("--ry-home", `${angle < -90 ? -270 : 90}deg`);
  }, [leaving]);
  if (!pose) return null;
  const print = <span className="manga-shelf-out__print" style={{ width: size.spine, height: size.height, transform: `scale(${520 / size.height})`, "--manga-height": `${size.height}px`, "--manga-spine-scale": 1, "--print-zoom": zoom } as CSSProperties}>
    <Spine decorative title={title} author={author} publisher={volume.publisher ?? publisher} ink={ink} tablet={tablet} volume={volume} latest={false} picked={false} privacy={privacy} focus={focus} owned={owned} src={src} onPick={() => undefined} onScanSample={() => setPaintedSide(side ?? null)} onImageLoad={() => undefined} onImageError={() => undefined} />
  </span>;
  return createPortal(<div ref={host} className={`spine-shelf__out manga-shelf-out${!painted ? " is-preparing" : leaving ? " is-leaving" : pulled ? "" : " is-pulling"}`} role="group" aria-label={`${volumeLabel(volume)} 꺼낸 책`}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === "spine-out-pull") setPulled(true); }}
    style={{ position: "fixed", left: pose.left, top: pose.top, bottom: "auto", "--out-w": `${pose.width}px`, "--out-h": `${pose.height}px`, "--out-depth": `${pose.depth}px`, "--lift": "12px", "--from": pose.from, "--paper-ink": ink, "--shadow-edge": pose.depth / (520 * size.width / size.height * .92) } as CSSProperties}>
    <CollectionCase data={{ title, platform: "book", privacy, front: src, back: volume.spineScan?.back ? mangaSpineScanUrl(volume.spineScan.back) : null, posterRatio: size.width / size.height }} paperbackSpine={print} open={false} stageBox={stageForCaseHeight(pose.height)} onOpenChange={onOpen} onReady={() => setFacesReady(faceKey)} />
  </div>, document.body);
}
