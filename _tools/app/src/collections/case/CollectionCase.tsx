import { useWorkImageReady } from "../work/useWorkImageReady";
import { useLongPress } from "../../shared/useLongPress";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useWorkTurnBlocked, useWorkTurnGesture } from "../work/WorkZoom";
import "./CollectionCase.css";
import "./CaseMaterials.css";
import { fitCollectionCase, type StageBox } from "./fitCaseStage";
import { CaseBack, type CaseBackContent } from "./CaseBack";
import { CASE_SOUND_ATTACK_MS, playCaseSound, preloadCaseSounds } from "./caseSounds";
import { watchCaseRaster } from "./caseRaster";
export { CaseInside } from "./CaseInside";

watchCaseRaster();

export type CasePlatform = "sw2" | "sw" | "ps5" | "ps4" | "pc" | "other" | "av" | "film" | "book";
/** NEC machines are not PCs; they stay unknown rather than getting the Steam spine. */
const NOT_PC = /pc[\s-]?(engine|fx|8\d|9\d)|turbografx/i;
/**
 * Every game lands in one of the five owned-device buckets (user, 2026-10-17): Xbox, phones and computers print as PC,
 * older Nintendo machines as Switch and older PlayStations as PS4. Only strings that fit none stay `other`.
 */
export function casePlatform(platforms: string | null, ownedPlatform?: string | null): CasePlatform {
  const platform = ownedPlatform?.trim() || platforms?.split("·")[0]?.trim() || "";
  if (/switch\s*2/i.test(platform)) return "sw2";
  if (/ps\s*5|playstation\s*5|ps\s*vr\s*2|playstation\s*vr\s*2/i.test(platform)) return "ps5";
  if (/\bps(\s*[1-4]|p|x|\s*vita|\s*vr)?\b|playstation|\bvita\b/i.test(platform)) return "ps4";
  if (/switch|nintendo|\bwii|game\s*boy|gamecube|famicom|family computer|\b(n64|nes|snes|(new\s*)?3?dsi?)\b|virtual boy/i.test(platform)) return "sw";
  if (NOT_PC.test(platform)) return "other";
  if (/\b(pc|windows|linux|mac|macos|macintosh|ms-dos|ios|android|xbox)\b|steam|mobile/i.test(platform)) return "pc";
  return "other";
}
/** Platforms printed from a package spine template (`.tpl` in CollectionCase.css); the rest get a bare spine with the title. */
const SPINE_TEMPLATES: CasePlatform[] = ["sw2", "sw", "ps5", "ps4", "pc"];
/** The case a work is drawn as: books, AV and films by type, games by their owned or first device. */
export function workCasePlatform(type: string, platforms: string | null | undefined, ownedPlatform?: string | null): CasePlatform {
  return type === "manga" ? "book" : type === "av" ? "av" : type === "movie" ? "film" : casePlatform(platforms ?? null, ownedPlatform);
}
export const CASE_PLASTIC: Record<CasePlatform, string> = {
  sw2: "rgba(206,44,54,.9)", sw: "rgba(214,222,230,.24)", ps5: "rgba(214,222,230,.24)", ps4: "rgba(30,78,176,.62)",
  pc: "rgba(16,18,22,.9)", other: "rgba(120,128,136,.38)", av: "rgba(10,10,11,.94)", film: "rgba(28,30,34,.92)", book: "rgb(236,231,220)",
};
export type CaseData = { title: string; author?: string | null; coverFocus?: number | null; volumeNumber?: 1 | null; publisher?: string | null; /** A game spine names its developer (user, 2026-10-05); books, films and AV keep the publisher/maker. */ developer?: string | null; platform: CasePlatform; front: string | null; spine?: string | null; back?: string | null; privacy: boolean; discLabel?: string; year?: number | null; posterRatio?: number; /** Poster board used only for the movie bookcase. */ board?: boolean };
export function spineInsertClass(data: CaseData) {
  return `ins${data.spine || data.privacy ? "" : SPINE_TEMPLATES.includes(data.platform) || data.board ? " full" : " bare"}`;
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
function TrayMedia({ data, front, holdable = false, holding = false }: { data: CaseData; front: string | null; holdable?: boolean; holding?: boolean }) {
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
      <span className={`disc${holding ? " is-holding" : ""}`} data-hold={holdable || undefined}>{label}{data.platform === "av" && !data.privacy && data.discLabel && <svg className="av-disc-rim" viewBox="0 0 200 200">
        <defs><path id={rimId} d="M 100,18 a 82,82 0 1,1 0,164 a 82,82 0 1,1 0,-164" /></defs>
        <text><textPath href={`#${rimId}`} textLength={2 * Math.PI * 82} lengthAdjust="spacingAndGlyphs">{data.discLabel}</textPath></text>
      </svg>}</span><span className="hub" />
    </span><span className="disc-note">PUSH</span>
  </span>;
}
const coarsePointer = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches);
/** The case's open/close move (`.kase` transition in CollectionCase.css). */
const UNFOLD_MS = 560;
/** A work screen's case sounds: `turn` counts the user's actions that opened or closed this case; `work` names the shown work. */
export type CaseSoundCue = { turn: number; work: string };

/**
 * Plays the open sound as the case starts opening and the close sound as the lid lands, only for a new `turn`:
 * mounting, switching works and a navigation that resets `open` stay silent. Reopening, another work, a missing
 * cue (an inactive surface) or unmounting cancels a close sound that is still waiting for its lid.
 */
function useCaseSound(cue: CaseSoundCue | undefined, open: boolean, platform: CasePlatform, lid: RefObject<HTMLElement | null>) {
  const heard = useRef(cue?.turn);
  const enabled = Boolean(cue);
  useEffect(() => { if (enabled) preloadCaseSounds(platform); }, [enabled, platform]);
  const turn = cue?.turn, work = cue?.work;
  useEffect(() => {
    if (turn === undefined) return;
    // The first turn a surface shows (on mount, or when an inactive slot becomes the shown one) is no action.
    const fresh = heard.current !== undefined && heard.current !== turn;
    heard.current = turn;
    if (!fresh) return;
    if (open) { playCaseSound(platform, "open"); return; }
    const node = lid.current;
    if (!node || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { playCaseSound(platform, "close"); return; }
    let done = false;
    const land = () => { if (done) return; done = true; cancel(); playCaseSound(platform, "close"); };
    const ended = (event: TransitionEvent) => { if (event.target === node && event.propertyName === "transform") land(); };
    // The clip's click comes ~30 ms in, so the timer starts it that much before the 560 ms lid lands.
    const timer = setTimeout(land, UNFOLD_MS - CASE_SOUND_ATTACK_MS);
    function cancel() { done = true; clearTimeout(timer); node!.removeEventListener("transitionend", ended); }
    node.addEventListener("transitionend", ended);
    return cancel;
    // `open` and the platform are read as committed with this turn; later changes alone never play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, work]);
}

/** Whether a point falls on the exposed disc. The 3D faces above it take the hit test, so the
 * target is the case body; the disc's projected box (a circle) decides instead. */
function onDisc(root: Element, x: number, y: number) {
  const disc = root.querySelector(".disc");
  if (!disc) return false;
  const r = disc.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const dx = (x - (r.left + r.width / 2)) / (r.width / 2), dy = (y - (r.top + r.height / 2)) / (r.height / 2);
  return dx * dx + dy * dy <= 1;
}

export function CollectionCase({ data, open, onOpenChange, frontReset = 0, inside, note, backContent, onReady, large = false, stageBox, sound, initialAngle = 28, onDiscHold }: {
  data: CaseData; open: boolean; onOpenChange(open: boolean): void; frontReset?: number;
  inside?: ReactNode; note?: ReactNode; backContent?: CaseBackContent; onReady?(): void; large?: boolean; stageBox?: StageBox;
  /** Only the work screen's case sounds; shelves and previews stay silent. */
  sound?: CaseSoundCue;
  /** The closed case's turn when it mounts (the shelf hands over the angle its pulled-out case was turned to). */
  initialAngle?: number;
  /** A long press on the exposed AV disc (PC): the work screen opens the product page. Without it the disc stays inert. */
  onDiscHold?(): void;
}) {
  const blocked = useWorkTurnBlocked();
  const gesture = useWorkTurnGesture();
  const lid = useRef<HTMLSpanElement>(null);
  useCaseSound(sound, open, data.platform, lid);
  const [angle, setAngle] = useState(open ? -10 : initialAngle);
  const [ratio, setRatio] = useState(.71);
  const [loadedFront, setLoadedFront] = useState<string | null>(null);
  const savedAngle = useRef(initialAngle);
  const lastReset = useRef(frontReset);
  const drag = useRef<{ pointer: number; x: number; angle: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  // While a drag turns the case, the angle goes straight onto the case element: no React render per pointer move
  // (the whole model re-rendered every move and stuttered on the tablet). The release commits it once.
  // It goes in as an inline transform, not as the inherited --ry: a changed custom property restyles every face, and the
  // faces printed with var(--grain) (floor, inner lid, inner spine) were repainted and re-rasterised each frame, which
  // took the Galaxy Tab from 120 to about 40 fps when zoomed in (2026-10-18). Keep the string equal to .kase { transform }.
  const kaseRef = useRef<HTMLDivElement>(null);
  const liveAngle = useRef<number | null>(null);
  function follow(next: number) {
    const value = ((next + 180) % 360 + 360) % 360 - 180;
    liveAngle.current = value;
    const node = kaseRef.current; if (!node) return;
    node.style.transform = `rotateX(-5deg) rotateY(${value}deg) translateX(calc(var(--open) * (var(--cw) + var(--cd)) * .5))`;
    node.dataset.angle = String(value);
    // The sheen repaints the whole front each frame: a touch screen moves it once, when the drag ends.
    if (!coarsePointer()) node.style.setProperty("--gloss", `${50 + value}%`);
  }
  // Once the drag is committed, --ry carries the same angle again and the inline transform goes.
  useLayoutEffect(() => { if (!dragging) kaseRef.current?.style.removeProperty("transform"); }, [dragging, angle]);
  function endDrag() {
    drag.current = null; setDragging(false);
    if (liveAngle.current !== null) { setAngle(liveAngle.current); liveAngle.current = null; }
  }
  const discHeld = useRef(false);
  const [discHolding, setDiscHolding] = useState(false);
  const holdable = Boolean(onDiscHold) && data.platform === "av" && !data.privacy && open;
  const press = useLongPress({ enabled: holdable, onStart: () => setDiscHolding(true), onEnd: () => setDiscHolding(false),
    onLongPress: () => { discHeld.current = true; setDiscHolding(false); onDiscHold?.(); } });
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

  const faceRatio = data.board ? data.posterRatio ?? 2 / 3 : ratio;
  const fit = stageBox ? fitCollectionCase(stageBox, faceRatio, open) : null;
  return <div className={`collection-case${data.platform === "film" ? " collection-case--film" : ""}${data.board ? " collection-case--board" : ""}${large ? " collection-case--large" : ""}${fit ? " collection-case--fitted" : ""}${open ? " is-open" : ""}`} data-unfolding={unfolding || undefined} style={{ "--ratio": faceRatio, "--plastic": CASE_PLASTIC[data.platform], ...(fit ? { "--ch": `${fit.height}px`, "--case-scale": fit.scale } : {}) } as CSSProperties}>
    <span className="floor-shadow" aria-hidden="true" />
    {/* This control is the physical media object, with rotation distinct from screen navigation. */}
    <div className="collection-case-object">
    <div ref={kaseRef} className={`kase${dragging ? " is-dragging" : ""}`} tabIndex={0} role="group" aria-label="케이스" aria-expanded={open} data-angle={angle} style={{ "--ry": `${angle}deg`, "--open": open ? 1 : 0, "--gloss": `${50 + angle}%` } as CSSProperties}
      onPointerDown={event => { if (blocked?.current) { endDrag(); return; } if (event.button !== 0 || drag.current) return; drag.current = { pointer: event.pointerId, x: event.clientX, angle, moved: false }; discHeld.current = false; if (holdable && ((event.target instanceof Element && event.target.closest(".disc")) || onDisc(event.currentTarget, event.clientX, event.clientY))) press.bind.onPointerDown(event); event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { press.bind.onPointerMove(event); if (blocked?.current) { endDrag(); return; } const start = drag.current; if (!start || start.pointer !== event.pointerId) return; if (!start.moved) { const lock = event.pointerType === "touch" ? gesture?.current : null; if (lock === "pending" || (lock !== "turn" && Math.abs(event.clientX - start.x) < 4)) return; start.moved = true; setDragging(true); } follow(start.angle + (event.clientX - start.x) * .6); }}
      onPointerUp={event => { press.bind.onPointerUp(); if (drag.current?.pointer !== event.pointerId) return; if (discHeld.current) { discHeld.current = false; endDrag(); return; } const click = !blocked?.current && drag.current && !drag.current.moved; endDrag(); if (click) onOpenChange(!open); }} onPointerCancel={() => { press.bind.onPointerCancel(); endDrag(); }} onLostPointerCapture={() => { press.cancel(); setDiscHolding(false); endDrag(); }}
      onKeyDown={event => {
        if (event.key === "ArrowLeft") turn(angle - 15);
        else if (event.key === "ArrowRight") turn(angle + 15);
        else if (event.key === "Home") setAngle(0);
        else if (event.key === "Enter" || event.key === " ") onOpenChange(!open);
        else return;
        event.preventDefault(); event.stopPropagation();
      }}>
      {data.board ? <>
        <span className="poster-board-front"><span className="ins">{face(data.front, "앞면")}</span></span>
        <span className="poster-board-back">{data.privacy && <span className="case-mask" />}</span>
        <span className="poster-board-spine"><span className={spineInsertClass(data)}><CaseSpine data={data} onSettled={url => images.failed("spine", url)} /></span></span>
        <span className="poster-board-edge" /><span className="poster-board-top" /><span className="poster-board-bottom" />
      </> : <>
      <span className="k-back"><span className="ins">{!data.back && !data.privacy && data.platform !== "book" ? <CaseBack data={data} content={backContent} /> : face(data.back, "뒷면")}</span></span>
      <span className="k-floor"><span className="k-floor-print"><TrayMedia data={data} front={loadedFront === data.front ? loadedFront : null} holdable={holdable} holding={discHolding} />{!data.privacy && note && <div className="note">{note}</div>}</span></span>
      <TrayWalls tray="base" /><span className="k-ridge" aria-hidden="true" />
      <span className="k-hinge"><span className="k-spine"><span className={spineInsertClass(data)}>
        <CaseSpine data={data} onSettled={url => images.failed("spine", url)} />
      </span></span><span className="k-spine-in" /><span ref={lid} className="k-lid"><span className="k-front"><span className="ins">{face(data.front, "앞면")}</span></span><span className="k-inner"><span className="tray-ledge" aria-hidden="true" />{data.privacy ? <span className="case-mask" aria-label="비공개 모드" /> : inside}</span><TrayWalls tray="lid" /></span></span>
      </>}
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

  const template = SPINE_TEMPLATES.includes(data.platform);
  const title = <span className="spine-title" data-title={decorative ? data.title : undefined}>{decorative ? null : data.title}</span>;
  const artwork = slots.map((url, index) => url && <img key={index} className="cv" src={url} decoding="async" alt={decorative ? "" : `${data.title} 책등`} draggable={false}
      style={hasPaintedSpine && painted === index ? undefined : { position: "absolute", visibility: "hidden", pointerEvents: "none" }}
      aria-hidden={painted !== index || undefined}
      onLoad={async event => {
        const image = event.currentTarget;
        try { await image.decode?.(); } catch { if (wanted.current === url) setFailed(url); return; }
        if (image.isConnected && wanted.current === url) setPainted(index as 0 | 1);
      }} onError={() => { if (wanted.current === url) setFailed(url); }} />);
  if (data.board) return <span className="case-spine-art">{data.privacy ? <span className="case-mask" /> :
    <span className="pspine" style={{ "--poster-ratio": data.posterRatio ?? 2 / 3, "--poster-focus": data.coverFocus ?? .5 } as CSSProperties}>
      <span className="ps-art" data-settled={hasPaintedSpine}>{artwork}</span>
      <span className="ps-band">{title}</span><span className="ps-foot"><span>{data.year}</span></span>
    </span>}</span>;
  return <span className="case-spine-art">{data.privacy ? <span className="case-mask" /> : <>
    {artwork}
    {!hasPaintedSpine && (templatePainted.current || failed === data.spine) && (template ?
    <span className={`tpl ${data.platform}`} data-spine-template={data.platform}>
      {/* Every Switch and Switch 2 spine ends in the Nintendo mark instead of the developer (user, 2026-10-17). */}
      <span className="t-head" /><span className="t-band">{title}</span><span className="t-foot">{data.platform === "sw2" || data.platform === "sw" ? <span className="t-mark" data-spine-mark="nintendo" aria-hidden="true" /> : <span className="t-pub">{data.developer}</span>}</span>
    </span> : title)}
  </>}</span>;
}
