import { useHorizontalWheel } from "../../shared/ui/useHorizontalWheel";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { workArtworkThumbnailUrl } from "../../assets/mediaUrl";
import { displayDate } from "../../shared/displayDate";
import { StableImage } from "../../shared/ui/StableImage";
import type { CaseData } from "../case/CollectionCase";
import { fitFlatJacket, type StageBox } from "../case/fitCaseStage";
import { useWorkImageReady } from "./useWorkImageReady";
import "./collectionWork.css";

/* The work screen's stage pieces as plain data, shared by the PC work screen and the tablet. */

// The meta line names one device (the case the work is drawn as), not every platform it was released on.
const DEVICE_NAMES: Partial<Record<CaseData["platform"], string>> = { sw2: "Switch 2", sw: "Switch", ps5: "PS5", pc: "PC" };
type WorkMetaSource = { type: string; platforms?: string | null; director?: string | null; releaseDate?: string | null };
function deviceLabel(collection: WorkMetaSource, platform: CaseData["platform"]) {
  if (collection.type !== "game") return null;
  return DEVICE_NAMES[platform] ?? collection.platforms?.split(/\s*[·,]\s*/)[0] ?? null;
}
/** The line under a work's title: a film's director, an AV code or a game's device, then the release date. */
export function workMeta(collection: WorkMetaSource, platform: CaseData["platform"], av: { productCode?: string | null; releaseDate?: string | null } | null) {
  return [collection.type === "movie" ? collection.director : av?.productCode ?? deviceLabel(collection, platform), displayDate(av?.releaseDate || collection.releaseDate)].filter(Boolean).join(" · ");
}
/** The work's hero art: its own hero, or a film's backdrop. Plain data so the tablet shares the rule. */
export function heroArtwork(collection: { type: string; selectedHeroArtworkId?: string | null; selectedBackdropArtworkId?: string | null }) {
  return collection.selectedHeroArtworkId || (collection.type === "movie" ? collection.selectedBackdropArtworkId : null) || null;
}
/** Artwork thumbnails, with the AV flat jacket first. Shared by PC and tablet. */
export function WorkStrip({ av, mode, artworks, privacy, frontThumbnailUrl, thumbnailUrl = workArtworkThumbnailUrl, onPick, onReady }: { av: boolean; mode: string; artworks: { id: string; kind?: string }[]; privacy: boolean; frontThumbnailUrl?: string | null; thumbnailUrl?(id: string): string | null; onPick(id: string): void; onReady?(): void }) {
  const stripWheel = useHorizontalWheel();
  const sources = Object.fromEntries(artworks.map(item => [item.id, privacy ? null : thumbnailUrl(item.id)]));
  const front = !privacy && av ? frontThumbnailUrl ?? null : null;
  const images = useWorkImageReady({ ...sources, flat: front }, onReady);
  if (!av && !artworks.length) return null;
  const pick = (id: string) => onPick(mode === id ? "case" : id);
  return <div ref={stripWheel} className="work-strip" aria-label="작품 보기">
    {av && <button className="work-strip-tile work-strip-art" aria-label="펼친 표지" aria-pressed={mode === "flat"} onClick={() => pick("flat")}><span className="work-strip-pic">{!privacy && frontThumbnailUrl && <img src={frontThumbnailUrl} alt="" draggable={false} onLoad={event => void images.loaded("flat", event)} onError={() => images.failed("flat", frontThumbnailUrl)} />}</span></button>}
    {artworks.map((item, index) => { const src = sources[item.id]; return <button className="work-strip-tile work-strip-art" key={item.id} aria-label={`${item.kind === "screenshot" ? "스크린샷" : "아트워크"} ${index + 1}`} aria-pressed={mode === item.id} onClick={() => pick(item.id)}><span className="work-strip-pic">{src && <img src={src} alt="" draggable={false} onLoad={event => void images.loaded(item.id, event)} onError={() => images.failed(item.id, src)} />}</span></button>; })}
  </div>;
}
export function HeroBand({ src, manga, onReady }: { src: string; manga: boolean; onReady(): void }) {
  const [settled, setSettled] = useState<{ generation: number; decoded: boolean } | null>(null);
  const requested = useRef({ src, generation: 0 });
  if (requested.current.src !== src) requested.current = { src, generation: requested.current.generation + 1 };
  const generation = requested.current.generation;
  useEffect(() => { if (settled?.generation === generation) onReady(); });
  return <div className={`work-hero-band${manga ? " work-hero-band--manga" : ""}`} aria-hidden="true" style={settled?.generation === generation && settled.decoded ? undefined : { visibility: "hidden" }}>
    {/* The surface's two slots retain this decoded element together with its case. */}
    <img src={src} alt="" draggable={false} onLoad={async event => {
      const image = event.currentTarget;
      try { await image.decode?.(); } catch { if (requested.current.generation === generation) setSettled({ generation, decoded: false }); return; }
      if (requested.current.generation !== generation || !image.isConnected) return;
      setSettled({ generation, decoded: true });
    }} onError={() => { if (requested.current.generation === generation) setSettled({ generation, decoded: false }); }} />
  </div>;
}
export function FlatJacket({ data, stageBox, onReady }: { data: CaseData; stageBox?: StageBox; onReady(): void }) {
  const [ratio, setRatio] = useState(.71);
  const fit = stageBox ? fitFlatJacket(stageBox, ratio) : null;
  const settled = useRef(new Set<string>());
  const sources = data.privacy ? [] : [data.front, data.back, data.spine].filter((url): url is string => Boolean(url));
  useEffect(() => { if (sources.every(source => settled.current.has(source))) onReady(); });
  function settle(url: string) { settled.current.add(url); if (sources.every(source => settled.current.has(source))) onReady(); }
  return <div className="work-flat" aria-label="펼친 표지"><div className="work-flat-sheet" style={{ "--flat-ratio": ratio, ...(fit ? { "--flat-height": `${fit.height}px`, "--flat-spine": `${fit.spine}px` } : {}) } as CSSProperties}>{([ ["뒷면", data.back], ["책등", data.spine], ["앞면", data.front] ]).map(([label, url]) => <figure key={label} className={label === "책등" ? "work-flat-spine" : undefined}>
    {!data.privacy && url ? <StableImage src={url} alt={`${data.title} ${label}`} onError={() => settle(url)} onLoad={async event => { const img = event.currentTarget; if (label === "앞면" && img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight); try { await img.decode?.(); } catch { /* Failed faces settle without blocking the sheet. */ } settle(url); }} /> : <span className="privacy-mask" aria-label={data.privacy ? "비공개 모드" : "이미지 없음"} />}<figcaption>{label}</figcaption>
  </figure>)}</div></div>;
}
