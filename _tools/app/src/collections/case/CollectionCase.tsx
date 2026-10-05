import { useWorkImageReady } from "../work/useWorkImageReady";
import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useWorkTurnBlocked } from "../work/WorkZoom";
import "./CollectionCase.css";
import "./CaseMaterials.css";
import { fitCollectionCase, type StageBox } from "./fitCaseStage";
import { CaseBack, type CaseBackContent } from "./CaseBack";
export { CaseInside } from "./CaseInside";

export type CasePlatform = "sw2" | "sw" | "ps5" | "pc" | "other" | "av" | "film" | "book";
export function casePlatform(platforms: string | null, ownedPlatform?: string | null): CasePlatform {
  const platform = ownedPlatform?.trim() || platforms?.split("·")[0]?.trim() || "";
  if (/switch\s*2/i.test(platform)) return "sw2";
  if (/switch/i.test(platform)) return "sw";
  if (/ps5|playstation\s*5/i.test(platform)) return "ps5";
  if (/\b(pc|windows|linux|mac|macos)\b|steam deck/i.test(platform)) return "pc";
  return "other";
}
/** The case a work is drawn as: books, AV and films by type, games by their owned or first device. */
export function workCasePlatform(type: string, platforms: string | null | undefined, ownedPlatform?: string | null): CasePlatform {
  return type === "manga" ? "book" : type === "av" ? "av" : type === "movie" ? "film" : casePlatform(platforms ?? null, ownedPlatform);
}
export const CASE_PLASTIC: Record<CasePlatform, string> = {
  sw2: "rgba(206,44,54,.9)", sw: "rgba(214,222,230,.24)", ps5: "rgba(214,222,230,.24)",
  pc: "rgba(120,128,136,.38)", other: "rgba(120,128,136,.38)", av: "rgba(10,10,11,.94)", film: "rgba(28,30,34,.92)", book: "rgb(236,231,220)",
};
export type CaseData = { title: string; author?: string | null; coverFocus?: number | null; volumeNumber?: 1 | null; publisher?: string | null; platform: CasePlatform; front: string | null; spine?: string | null; back?: string | null; privacy: boolean; discLabel?: string };
export function spineInsertClass(data: CaseData) {
  return `ins${data.spine || data.privacy ? "" : ["sw2", "sw", "ps5"].includes(data.platform) ? " full" : " bare"}`;
}
export type Fact = [string, ReactNode];
export function CaseFacts({ rows }: { rows: Fact[] }) {
  return <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function caseTray(platform: CasePlatform) {
  return platform === "sw" || platform === "sw2" ? "card" : "disc";
}
function TrayWalls({ tray }: { tray: "base" | "lid" }) {
  return <>{(["top", "bottom", "outer"] as const).map(wall => <Fragment key={wall}>
    <span className={`k-wall k-${tray}-wall k-wall-${wall}`} aria-hidden="true" />
    <span className={`k-wall k-${tray}-wall k-wall-${wall}-in`} aria-hidden="true" />
    <span className={`k-lip k-${tray}-lip k-lip-${wall}`} aria-hidden="true" />
  </Fragment>)}</>;
}
function TrayMedia({ data, front }: { data: CaseData; front: string | null }) {
  const rimId = useId();
  const label = <span className="media-label" style={!data.privacy && front ? { backgroundImage: `url(${JSON.stringify(front)})` } : undefined}>
    {data.privacy && <span className="case-mask" />}
  </span>;
  return caseTray(data.platform) === "card" ? <span className="tray-media tray-media--card" aria-hidden="true">
    <span className="tray-frame" /><span className="tray-rib tray-rib-one" /><span className="tray-rib tray-rib-two" />
    <span className="tray-emboss">GAME CARD</span><span className="finger-notch" />
    <span className="cart-slot"><span className="cart">{label}</span><span className="nub nub-top" /><span className="nub nub-bottom" /></span>
  </span> : <span className="tray-media tray-media--disc" aria-hidden="true">
    <span className="holder"><span className="thumb thumb-left" /><span className="thumb thumb-right" />
      <span className="disc">{label}{data.platform === "av" && !data.privacy && data.discLabel && <svg className="av-disc-rim" viewBox="0 0 200 200">
        <defs><path id={rimId} d="M 100,18 a 82,82 0 1,1 0,164 a 82,82 0 1,1 0,-164" /></defs>
        <text><textPath href={`#${rimId}`} textLength={2 * Math.PI * 82} lengthAdjust="spacingAndGlyphs">{data.discLabel}</textPath></text>
      </svg>}</span><span className="hub" />
    </span><span className="disc-note">PUSH</span>
  </span>;
}
/** The case's open/close move (`.kase` transition in CollectionCase.css). */
const UNFOLD_MS = 560;

export function CollectionCase({ data, open, onOpenChange, frontReset = 0, inside, note, backContent, onReady, large = false, stageBox }: {
  data: CaseData; open: boolean; onOpenChange(open: boolean): void; frontReset?: number;
  inside?: ReactNode; note?: ReactNode; backContent?: CaseBackContent; onReady?(): void; large?: boolean; stageBox?: StageBox;
}) {
  const blocked = useWorkTurnBlocked();
  const [angle, setAngle] = useState(open ? -10 : 28);
  const [ratio, setRatio] = useState(.71);
  const [loadedFront, setLoadedFront] = useState<string | null>(null);
  const savedAngle = useRef(28);
  const lastReset = useRef(frontReset);
  const drag = useRef<{ pointer: number; x: number; angle: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Opening refits the stage (the open case is twice as wide). The fit scale moves on the unfolding's
  // curve only while it opens or closes; stage resizes and cover settling still apply at once.
  const [unfolding, setUnfolding] = useState(false);
  const [shownOpen, setShownOpen] = useState(open);
  if (shownOpen !== open) { setShownOpen(open); setUnfolding(true); }
  useEffect(() => {
    if (!unfolding) return;
    const timer = setTimeout(() => setUnfolding(false), UNFOLD_MS + 40);
    return () => clearTimeout(timer);
  }, [unfolding, open]);
  const sources = { front: data.privacy ? null : data.front, back: data.privacy ? null : data.back ?? null, spine: data.privacy ? null : data.spine ?? null };
  const signature = JSON.stringify(sources);
  const ready = useRef({ signature, notified: false });
  if (ready.current.signature !== signature) ready.current = { signature, notified: false };
  const images = useWorkImageReady(sources, () => {
    if (!ready.current.notified && onReady) { ready.current.notified = true; onReady(); }
  });
  useEffect(() => { setAngle(0); if (lastReset.current !== frontReset) savedAngle.current = 0; lastReset.current = frontReset; drag.current = null; setDragging(false); }, [frontReset]);
  useEffect(() => {
    if (open) { savedAngle.current = angle; setAngle(-10); }
    else setAngle(savedAngle.current);
  }, [open]);
  function turn(next: number) { setAngle(((next + 180) % 360 + 360) % 360 - 180); }
  function face(url: string | null | undefined, label: string) {
    if (data.privacy) return <span className="case-mask" aria-label="비공개 모드" />;
    if (!url) return null;
    const key = label === "앞면" ? "front" : "back";
    return <img key={url} className="cv" src={url} alt={`${data.title} ${label}`} draggable={false} onLoad={event => {
      const image = event.currentTarget;
      image.style.removeProperty("visibility");
      if (label === "앞면" && image.naturalWidth && image.naturalHeight) setRatio(image.naturalWidth / image.naturalHeight);
      // The interior print shares the loaded front URL and adds no image readiness key.
      if (key === "front") setLoadedFront(url);
      void images.loaded(key, event);
    }} onError={event => {
      event.currentTarget.style.visibility = "hidden";
      if (key === "front") setLoadedFront(null);
      images.failed(key, url);
    }} />;
  }

  const fit = stageBox ? fitCollectionCase(stageBox, ratio, open) : null;
  return <div className={`collection-case${data.platform === "film" ? " collection-case--film" : ""}${large ? " collection-case--large" : ""}${fit ? " collection-case--fitted" : ""}${open ? " is-open" : ""}`} data-unfolding={unfolding || undefined} style={{ "--ratio": ratio, "--plastic": CASE_PLASTIC[data.platform], ...(fit ? { "--ch": `${fit.height}px`, "--case-scale": fit.scale } : {}) } as CSSProperties}>
    <span className="floor-shadow" aria-hidden="true" />
    {/* This control is the physical media object, with rotation distinct from screen navigation. */}
    <div className="collection-case-object">
    <div className={`kase${dragging ? " is-dragging" : ""}`} tabIndex={0} role="group" aria-label="케이스" aria-expanded={open} data-angle={angle} style={{ "--ry": `${angle}deg`, "--open": open ? 1 : 0, "--gloss": `${50 + angle}%` } as CSSProperties}
      onPointerDown={event => { if (blocked?.current) { drag.current = null; setDragging(false); return; } if (event.button !== 0 || drag.current) return; drag.current = { pointer: event.pointerId, x: event.clientX, angle, moved: false }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { if (blocked?.current) { drag.current = null; setDragging(false); return; } const start = drag.current; if (!start || start.pointer !== event.pointerId) return; if (!start.moved && Math.abs(event.clientX - start.x) < 4) return; if (!start.moved) { start.moved = true; setDragging(true); } turn(start.angle + (event.clientX - start.x) * .6); }}
      onPointerUp={event => { if (drag.current?.pointer !== event.pointerId) return; const click = !blocked?.current && drag.current && !drag.current.moved; drag.current = null; setDragging(false); if (click) onOpenChange(!open); }} onPointerCancel={() => { drag.current = null; setDragging(false); }} onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onKeyDown={event => {
        if (event.key === "ArrowLeft") turn(angle - 15);
        else if (event.key === "ArrowRight") turn(angle + 15);
        else if (event.key === "Home") setAngle(0);
        else if (event.key === "Enter" || event.key === " ") onOpenChange(!open);
        else return;
        event.preventDefault(); event.stopPropagation();
      }}>
      <span className="k-back"><span className="ins">{!data.back && !data.privacy && data.platform !== "book" ? <CaseBack data={data} content={backContent} /> : face(data.back, "뒷면")}</span></span>
      <span className="k-floor"><TrayMedia data={data} front={loadedFront === data.front ? loadedFront : null} />{!data.privacy && note && <div className="note">{note}</div>}</span>
      <TrayWalls tray="base" /><span className="k-ridge" aria-hidden="true" />
      <span className="k-hinge"><span className="k-spine"><span className={spineInsertClass(data)}>
        <CaseSpine data={data} onSettled={url => images.failed("spine", url)} />
      </span></span><span className="k-spine-in" /><span className="k-lid"><span className="k-front"><span className="ins">{face(data.front, "앞면")}</span></span><span className="k-inner"><span className="tray-ledge" aria-hidden="true" />{data.privacy ? <span className="case-mask" aria-label="비공개 모드" /> : inside}</span><TrayWalls tray="lid" /></span></span>
    </div>
    </div>
  </div>;
}

/** Both the work case and the light shelf case use the same package printing. */
export function CaseSpine({ data, decorative = false, onSettled }: { data: CaseData; decorative?: boolean; onSettled?(url: string): void }) {
  const [slots, setSlots] = useState<[string | null, string | null]>([data.spine ?? null, null]);
  const [painted, setPainted] = useState<0 | 1 | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const templatePainted = useRef(!data.spine);
  if (!data.spine || failed === data.spine) templatePainted.current = true;
  const wanted = useRef(data.spine); wanted.current = data.spine;
  useEffect(() => {
    if (!data.spine || (painted !== null && slots[painted] === data.spine)) return;
    const next = painted === 0 ? 1 : 0;
    if (slots[next] === data.spine) return;
    setSlots(current => next === 0 ? [data.spine ?? null, current[1]] : [current[0], data.spine ?? null]);
  }, [data.spine, painted, slots]);
  const hasPaintedSpine = Boolean(data.spine && painted !== null);
  useEffect(() => {
    if (!data.privacy && data.spine && ((painted !== null && slots[painted] === data.spine) || failed === data.spine)) onSettled?.(data.spine);
  });

  const template = ["sw2", "sw", "ps5"].includes(data.platform);
  const title = <span className="spine-title" data-title={decorative ? data.title : undefined}>{decorative ? null : data.title}</span>;
  return <span className="case-spine-art">{data.privacy ? <span className="case-mask" /> : <>
    {slots.map((url, index) => url && <img key={index} className="cv" src={url} decoding="async" loading={decorative ? "lazy" : undefined} alt={decorative ? "" : `${data.title} 책등`} draggable={false}
      style={hasPaintedSpine && painted === index ? undefined : { position: "absolute", visibility: "hidden", pointerEvents: "none" }}
      aria-hidden={painted !== index || undefined}
      onLoad={async event => {
        const image = event.currentTarget;
        try { await image.decode?.(); } catch { if (wanted.current === url) setFailed(url); return; }
        if (image.isConnected && wanted.current === url) setPainted(index as 0 | 1);
      }} onError={() => { if (wanted.current === url) setFailed(url); }} />)}
    {!hasPaintedSpine && (templatePainted.current || failed === data.spine) && (template ?
    <span className={`tpl ${data.platform}`} data-spine-template={data.platform} data-nintendo={/nintendo|닌텐도/i.test(data.publisher ?? "") ? "" : undefined}>
      <span className="t-head" /><span className="t-band">{title}</span><span className="t-foot"><span className="t-pub">{data.publisher}</span></span>
    </span> : title)}
  </>}</span>;
}
