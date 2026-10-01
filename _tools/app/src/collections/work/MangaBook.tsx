import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import "../case/CaseMaterials.css";
import { stripPosition } from "./coverStrip";
import { fitSpineTitle, spineTitleSplits, verticalSpineRuns, verticalSpineText, SPINE_TITLE_SCALE, type SpineTitleFit } from "./verticalText";

/** Share of the spine height the title may take; the rest holds the number, illustration and author. */
const TITLE_SHARE = .52;
/** Upright vertical type: mapped punctuation, upright one- or two-digit numbers. */
function Vertical({ text }: { text: string }) {
  return <>{verticalSpineRuns(verticalSpineText(text)).map((run, index) => run.upright ? <span key={index} className="manga-jspine-tcy">{run.text}</span> : <Fragment key={index}>{run.text}</Fragment>)}</>;
}

/** Shared print; only the work book supplies fitted columns and a measuring ruler. */
export function MangaSpineFace({ title, author, volumeNumber, illustration, titleFit, spineRef, illustrationRef, children }: {
  title: string; author?: string | null; volumeNumber?: number | null; illustration: ReactNode;
  titleFit?: SpineTitleFit; spineRef?: Ref<HTMLSpanElement>; illustrationRef?: Ref<HTMLSpanElement>; children?: ReactNode;
}) {
  const fit = titleFit ?? { scale: SPINE_TITLE_SCALE.base, columns: [title], clipped: false };
  return <span ref={spineRef} className="manga-jspine" style={{ "--title-share": TITLE_SHARE, "--title-base": SPINE_TITLE_SCALE.base } as CSSProperties}>
    <span className={`manga-jspine-title${fit.columns.length > 1 ? " manga-jspine-title--columns" : ""}`} style={{ "--title-scale": fit.scale } as CSSProperties}>
      {fit.columns.map((column, index) => <span key={index} className="manga-jspine-column"><Vertical text={column} /></span>)}
    </span>
    {volumeNumber != null && <span className="manga-jspine-number">{volumeNumber}</span>}
    <span ref={illustrationRef} className="manga-jspine-illustration">{illustration}</span>
    {author && <span className="manga-jspine-author"><Vertical text={author} /></span>}
    <span className="manga-jspine-bar" />
    {children}
  </span>;
}

// The work surface retains the old book until every visible face of this one decodes.
export function MangaBook({ src, title, author, volumeNumber, volumeTitle, focus, privacy, frontReset, onReady }: {
  src: string | null; title: string; author: string | null; volumeNumber: number | null; volumeTitle: string;
  focus: number | null; privacy: boolean; frontReset: number; onReady(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const illustration = useRef<HTMLSpanElement>(null);
  const spine = useRef<HTMLSpanElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  // The ruler holds every candidate column at the base size; the fit is decided before paint.
  const rulerTexts = useMemo(() => [...new Set([title, ...spineTitleSplits(title).flatMap(split => split.parts)])], [title]);
  const [titleFit, setTitleFit] = useState<SpineTitleFit & { title: string }>({ title, scale: SPINE_TITLE_SCALE.base, columns: [title], clipped: false });
  const [angle, setAngle] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [ratio, setRatio] = useState(.71);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [cut, setCut] = useState({ width: 34, height: 560 });
  const drag = useRef<{ pointer: number; x: number; angle: number; moved: boolean } | null>(null);
  const presentation = JSON.stringify([src, privacy]);
  const settled = useRef({ presentation, generation: 0, faces: new Set<string>() });
  if (settled.current.presentation !== presentation) settled.current = { presentation, generation: settled.current.generation + 1, faces: new Set<string>() };
  const generation = settled.current.generation;
  const ready = useRef(onReady); ready.current = onReady;
  const sourcesReady = privacy || !src || ["front", "back", "illustration"].every(face => settled.current.faces.has(face));
  useEffect(() => { if (sourcesReady) ready.current(); });
  useEffect(() => { setAngle(0); drag.current = null; setDragging(false); }, [frontReset, src, title, volumeNumber]);
  useLayoutEffect(() => {
    const node = host.current; if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width > 0 && height > 0) setBox(previous => previous?.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node); return () => observer?.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = illustration.current; if (!node) return;
    // Measure the unscaled print so the stored focus stays centred in the actual cut.
    const measure = () => {
      const width = node.clientWidth, height = node.clientHeight;
      if (width > 0 && height > 0) setCut(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node); return () => observer?.disconnect();
  }, [privacy, title, author, volumeNumber]);
  useLayoutEffect(() => {
    const node = spine.current, measuring = ruler.current; if (!node || !measuring) return;
    const measure = () => {
      const lengths = new Map([...measuring.children].map(child => [(child as HTMLElement).dataset.text ?? "", (child as HTMLElement).offsetHeight]));
      const fit = { title, ...fitSpineTitle(title, { available: node.clientHeight * TITLE_SHARE, width: node.clientWidth, length: text => lengths.get(text) ?? 0 }) };
      setTitleFit(previous => JSON.stringify(previous) === JSON.stringify(fit) ? previous : fit);
    };
    measure();
    // Web fonts change the measured lengths after they load.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(measuring);
    let live = true;
    document.fonts?.ready.then(() => { if (live) measure(); });
    return () => { live = false; observer?.disconnect(); };
  }, [privacy, title]);
  const shownTitle = titleFit.title === title ? titleFit : { scale: SPINE_TITLE_SCALE.base, columns: [title], clipped: false };
  function settle(face: string) {
    if (settled.current.generation !== generation) return;
    settled.current.faces.add(face);
    if (["front", "back", "illustration"].every(item => settled.current.faces.has(item))) ready.current();
  }
  function cover(face: string) {
    if (privacy) return <span className="privacy-mask" aria-label="비공개 모드" />;
    if (!src) return null;
    return <img src={src} alt={face === "front" ? `${volumeTitle || title} 표지` : ""} draggable={false}
      style={face === "illustration" ? { objectPosition: `${stripPosition(focus, cut.height * ratio, cut.width)}% 30%` } : undefined}
      onLoad={async event => {
        const image = event.currentTarget;
        if (face === "front" && image.naturalWidth && image.naturalHeight) setRatio(image.naturalWidth / image.naturalHeight);
        let decoded = true;
        try { await image.decode?.(); } catch { decoded = false; }
        if (settled.current.generation !== generation || image.getAttribute("src") !== src || !image.isConnected) return;
        if (decoded) image.style.removeProperty("visibility");
        else image.style.visibility = "hidden";
        settle(face);
      }} onError={event => { event.currentTarget.style.visibility = "hidden"; settle(face); }} />;
  }
  // Keep angles continuous so a drag through the back never eases around the long way.
  // A turned book comes closer under perspective, so leave headroom (0.88) for it to stay inside the stage.
  const scale = box ? Math.max(0, Math.min(1, (box.width - 32) / (560 * ratio + 34), (box.height - 32) / 560) * .88) : 1;
  return <div ref={host} className="manga-work-book" style={{ "--book-scale": scale, "--ratio": ratio } as CSSProperties}>
    <span className="manga-book-shadow" aria-hidden="true" />
    {/* Rotation is an interaction with the physical book, separate from volume navigation. */}
    <div className={`manga-bigbook${dragging ? " is-dragging" : ""}`} role="group" aria-label="책" tabIndex={0} data-angle={angle} style={{ "--ty": `${angle}deg` } as CSSProperties}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { pointer: event.pointerId, x: event.clientX, angle, moved: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }} onPointerMove={event => {
        const start = drag.current; if (!start || event.pointerId !== start.pointer) return;
        const distance = event.clientX - start.x;
        if (!start.moved && Math.abs(distance) < 4) return;
        start.moved = true; setDragging(true); setAngle(start.angle + distance * .6);
      }} onPointerUp={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = null; setDragging(false);
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { drag.current = null; setDragging(false); }} onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onKeyDown={event => {
        if (event.key === "ArrowLeft") setAngle(value => value - 15);
        else if (event.key === "ArrowRight") setAngle(value => value + 15);
        else if (event.key === "Home") setAngle(0);
        else return;
        event.preventDefault(); event.stopPropagation();
      }}>
      <span className="manga-bb-back">{cover("back")}</span>
      <span className="manga-bb-spine">{privacy ? <span className="privacy-mask" aria-label="비공개 모드" /> : <MangaSpineFace title={title} author={author} volumeNumber={volumeNumber} illustration={cover("illustration")} titleFit={shownTitle} spineRef={spine} illustrationRef={illustration}>
        <span ref={ruler} className="manga-jspine-ruler" aria-hidden="true">{rulerTexts.map(text => <span key={text} data-text={text}><Vertical text={text} /></span>)}</span>
      </MangaSpineFace>}</span>
      <span className="manga-bb-pages" aria-hidden="true" /><span className="manga-bb-top" aria-hidden="true" />
      <span className="manga-bb-front">{cover("front")}{!privacy && !src && <span className="manga-cover-empty">표지가 없습니다.</span>}</span>
    </div>
  </div>;
}
