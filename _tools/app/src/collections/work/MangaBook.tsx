import { useWorkTurnBlocked } from "./WorkZoom";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import "../case/CaseMaterials.css";
import { MangaBack, coverAverageColor, MANGA_BACK_COLOR, type MangaBackData } from "./MangaBack";
import { stripPosition } from "./coverStrip";
import { fitSpineAuthor, spineAuthorColumns, fitSpineTitle, spineTitleSplits, verticalSpineRuns, verticalSpineText, SPINE_TITLE_SCALE, type SpineTitleFit } from "./verticalText";

/** Share of the spine height the title may take; the rest holds the number, illustration and author. */
const TITLE_SHARE = .38;
/** Upright vertical type: mapped punctuation, upright one- or two-digit numbers. */
function Vertical({ text }: { text: string }) {
  return <>{verticalSpineRuns(verticalSpineText(text)).map((run, index) => run.orientation === "mixed" ? <Fragment key={index}>{run.text}</Fragment> : <span key={index} className={run.orientation === "combined" ? "manga-jspine-tcy" : "manga-jspine-upright"}>{run.text}</span>)}</>;
}

/** Shelf and stage use the same print and fixed bands. */
export function MangaSpineFace({ title, author, volumeNumber, illustration, illustrationRef, shelf = false }: {
  title: string; author?: string | null; volumeNumber?: number | null; illustration: ReactNode;
  illustrationRef?: Ref<HTMLSpanElement>; shelf?: boolean;
}) {
  const spine = useRef<HTMLSpanElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const authorRuler = useRef<HTMLSpanElement>(null);
  const rulerTexts = useMemo(() => [...new Set([title, ...spineTitleSplits(title).flatMap(split => split.parts)])], [title]);
  const authorColumns = spineAuthorColumns(author ?? "");
  const [titleFit, setTitleFit] = useState<SpineTitleFit>({ scale: SPINE_TITLE_SCALE.base, columns: [title], clipped: false });
  const [authorFit, setAuthorFit] = useState({ fontSize: 7, inlineScale: 1 });
  useLayoutEffect(() => {
    if (shelf) return;
    const node = spine.current, measuring = ruler.current, authors = authorRuler.current;
    if (!node || !measuring || !authors) return;
    const measure = () => {
      const lengths = new Map([...measuring.children].map(child => [(child as HTMLElement).dataset.text ?? "", (child as HTMLElement).offsetHeight]));
      const fit = fitSpineTitle(title, { available: node.clientHeight * TITLE_SHARE, width: node.clientWidth, length: text => lengths.get(text) ?? 0 });
      setTitleFit(previous => JSON.stringify(previous) === JSON.stringify(fit) ? previous : fit);
      const authorLengths = new Map([...authors.children].map(child => [(child as HTMLElement).dataset.text ?? "", (child as HTMLElement).offsetHeight]));
      const fitted = fitSpineAuthor(author ?? "", { available: node.clientHeight * .145, base: Math.max(7, node.clientWidth * .3), length: text => authorLengths.get(text) ?? 0 });
      setAuthorFit(previous => previous.fontSize === fitted.fontSize && previous.inlineScale === fitted.inlineScale ? previous : fitted);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node); observer?.observe(measuring); observer?.observe(authors);
    let live = true;
    document.fonts?.ready.then(() => { if (live) measure(); });
    return () => { live = false; observer?.disconnect(); };
  }, [title, author, shelf]);
  // Shelf geometry has an 8% depth; conservative cell lengths avoid per-item layout work.
  const cells = (text: string) => verticalSpineRuns(verticalSpineText(text)).reduce((total, run) => total + (run.orientation === "combined" ? 1 : Array.from(run.text).length), 0);
  const fit = shelf ? fitSpineTitle(title, { available: 100 * TITLE_SHARE, width: 8, length: text => cells(text) * 8 * SPINE_TITLE_SCALE.base * 1.2 }) : titleFit;
  return <span ref={spine} className="manga-jspine" style={{ "--title-share": TITLE_SHARE, "--title-base": SPINE_TITLE_SCALE.base } as CSSProperties}>
    <span className={`manga-jspine-title${fit.columns.length > 1 ? " manga-jspine-title--columns" : ""}`} style={{ "--title-scale": fit.scale } as CSSProperties}>
      {fit.columns.map((column, index) => <span key={index} className="manga-jspine-column"><Vertical text={column} /></span>)}
    </span>
    {volumeNumber != null && <span className="manga-jspine-number">{volumeNumber}</span>}
    <span ref={illustrationRef} className="manga-jspine-illustration">{illustration}</span>
    {author && <span className="manga-jspine-author" aria-label={author} style={(shelf ? { "--author-cells": Math.max(1, ...authorColumns.map(cells)), "--author-columns": authorColumns.length } : { fontSize: authorFit.fontSize, transform: `translateX(-50%) scaleY(${authorFit.inlineScale})` }) as CSSProperties}>{authorColumns.map((column, index) => <span key={index} className="manga-jspine-column"><Vertical text={column} /></span>)}</span>}
    <span className="manga-jspine-bar" />
    {!shelf && <span ref={ruler} className="manga-jspine-ruler" aria-hidden="true">{rulerTexts.map(text => <span key={text} data-text={text}><Vertical text={text} /></span>)}</span>}
    {!shelf && <span ref={authorRuler} className="manga-jspine-ruler manga-jspine-author-ruler" aria-hidden="true">{authorColumns.map(text => <span key={text} data-text={text}><Vertical text={text} /></span>)}</span>}
  </span>;
}

// The work surface retains the old book until every visible face of this one decodes.
export function MangaBook({ src, title, author, volumeNumber, volumeTitle, focus, privacy, frontReset, onReady, ...back }: MangaBackData & {
  src: string | null; title: string; author: string | null; volumeNumber: number | null; volumeTitle: string;
  focus: number | null; privacy: boolean; frontReset: number; onReady(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const illustration = useRef<HTMLSpanElement>(null);
  const [angle, setAngle] = useState(0);
  const blocked = useWorkTurnBlocked();
  const [dragging, setDragging] = useState(false);
  const [ratio, setRatio] = useState(.71);
  const [backColor, setBackColor] = useState({ src, color: MANGA_BACK_COLOR });
  const [, setSettledVersion] = useState(0);
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
      const width = node.clientWidth, height = node.clientHeight;
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
  function settle(face: string) {
    if (settled.current.generation !== generation) return;
    settled.current.faces.add(face);
    // Publish readiness after the sampled colour commits with the decoded faces.
    if (["front", "back", "illustration"].every(item => settled.current.faces.has(item))) setSettledVersion(value => value + 1);
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
        if (face === "front") setBackColor({ src, color: decoded ? coverAverageColor(image) : MANGA_BACK_COLOR });
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
    <div className="manga-book-object">
    <div className={`manga-bigbook${dragging ? " is-dragging" : ""}`} role="group" aria-label="책" tabIndex={0} data-angle={angle} style={{ "--ty": `${angle}deg` } as CSSProperties}
      onPointerDown={event => {
        if (blocked?.current) { drag.current = null; setDragging(false); return; }
        if (event.button !== 0 || drag.current) return;
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { pointer: event.pointerId, x: event.clientX, angle, moved: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }} onPointerMove={event => {
        if (blocked?.current) { drag.current = null; setDragging(false); return; }
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
      <span className="manga-bb-back">{privacy ? <span className="privacy-mask" aria-label="비공개 모드" /> : <MangaBack {...back} title={title} volumeNumber={volumeNumber} color={backColor.src === src ? backColor.color : MANGA_BACK_COLOR} picture={cover("back")} />}</span>
      <span className="manga-bb-spine">{privacy ? <span className="privacy-mask" aria-label="비공개 모드" /> : <MangaSpineFace title={title} author={author} volumeNumber={volumeNumber} illustration={cover("illustration")} illustrationRef={illustration} />}</span>
      <span className="manga-bb-pages" aria-hidden="true" /><span className="manga-bb-top" aria-hidden="true" />
      <span className="manga-bb-front">{cover("front")}{!privacy && !src && <span className="manga-cover-empty">표지가 없습니다.</span>}</span>
    </div>
    </div>
  </div>;
}
