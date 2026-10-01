import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./CollectionCase.css";
import "./CaseMaterials.css";
import { fitCollectionCase, type StageBox } from "./fitCaseStage";

export type CasePlatform = "sw2" | "sw" | "ps5" | "pc" | "other" | "av" | "film";
export function casePlatform(platforms: string | null): CasePlatform {
  if (/switch\s*2/i.test(platforms ?? "")) return "sw2";
  if (/switch/i.test(platforms ?? "")) return "sw";
  if (/ps5|playstation\s*5/i.test(platforms ?? "")) return "ps5";
  if (/pc|windows/i.test(platforms ?? "")) return "pc";
  return "other";
}
export const CASE_PLASTIC: Record<CasePlatform, string> = {
  sw2: "rgba(206,44,54,.9)", sw: "rgba(214,222,230,.24)", ps5: "rgba(214,222,230,.24)",
  pc: "rgba(120,128,136,.38)", other: "rgba(120,128,136,.38)", av: "rgba(10,10,11,.94)", film: "rgba(28,30,34,.92)",
};
export type CaseData = { title: string; publisher?: string | null; platform: CasePlatform; front: string | null; spine?: string | null; back?: string | null; privacy: boolean };
export function spineInsertClass(data: CaseData) {
  return `ins${data.spine || data.privacy ? "" : ["sw2", "sw", "ps5"].includes(data.platform) ? " full" : " bare"}`;
}
export type Fact = [string, ReactNode];
export function CaseFacts({ rows }: { rows: Fact[] }) {
  return <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function CaseInside({ record, facts }: { record: Fact[]; facts: Fact[] }) {
  return <><span className="clip clip-one" /><span className="clip clip-two" /><div className="slip"><b>내 기록</b><CaseFacts rows={record} /></div><div className="card2"><b>작품 정보</b><CaseFacts rows={facts} /></div></>;
}
export function CollectionCase({ data, open, onOpenChange, frontReset = 0, inside, note, onReady, large = false, stageBox }: {
  data: CaseData; open: boolean; onOpenChange(open: boolean): void; frontReset?: number;
  inside?: ReactNode; note?: ReactNode; onReady?(): void; large?: boolean; stageBox?: StageBox;
}) {
  const [angle, setAngle] = useState(open ? -10 : 28);
  const [ratio, setRatio] = useState(.71);
  const savedAngle = useRef(28);
  const drag = useRef<{ x: number; angle: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const settled = useRef(new Set<string>());
  const readyRef = useRef(onReady); readyRef.current = onReady;
  const sources = data.privacy ? [] : [data.front, data.spine, data.back].filter((url): url is string => Boolean(url));
  useEffect(() => { if (sources.every(source => settled.current.has(source))) readyRef.current?.(); });
  useEffect(() => { setAngle(0); }, [frontReset]);
  useEffect(() => {
    if (open) { savedAngle.current = angle; setAngle(-10); }
    else setAngle(savedAngle.current);
  }, [open]);
  function turn(next: number) { setAngle(((next + 180) % 360 + 360) % 360 - 180); }
  function face(url: string | null | undefined, label: string) {
    if (data.privacy) return <span className="case-mask" aria-label="비공개 모드" />;
    if (!url) return null;
    return <img className="cv" src={url} alt={`${data.title} ${label}`} draggable={false} onLoad={async event => {
      const image = event.currentTarget;
      image.style.removeProperty("visibility");
      if (label === "앞면" && image.naturalWidth && image.naturalHeight) setRatio(image.naturalWidth / image.naturalHeight);
      try { await image.decode?.(); } catch { /* A failed decode settles as an unavailable face. */ }
      settled.current.add(url);
      if (sources.every(source => settled.current.has(source))) readyRef.current?.();
    }} onError={event => {
      event.currentTarget.style.visibility = "hidden";
      settled.current.add(url);
      if (sources.every(source => settled.current.has(source))) readyRef.current?.();
    }} />;
  }

  const fit = stageBox ? fitCollectionCase(stageBox, ratio, open) : null;
  return <div className={`collection-case${data.platform === "film" ? " collection-case--film" : ""}${large ? " collection-case--large" : ""}${fit ? " collection-case--fitted" : ""}${open ? " is-open" : ""}`} style={{ "--ratio": ratio, "--plastic": CASE_PLASTIC[data.platform], ...(fit ? { "--ch": `${fit.height}px`, "--case-scale": fit.scale } : {}) } as CSSProperties}>
    <span className="floor-shadow" aria-hidden="true" />
    {/* This control is the physical media object, with rotation distinct from screen navigation. */}
    <div className={`kase${dragging ? " is-dragging" : ""}`} tabIndex={0} role="group" aria-label="케이스" aria-expanded={open} data-angle={angle} style={{ "--ry": `${angle}deg`, "--open": open ? 1 : 0, "--gloss": `${50 + angle}%` } as CSSProperties}
      onPointerDown={event => { if (event.button !== 0) return; drag.current = { x: event.clientX, angle, moved: false }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { const start = drag.current; if (!start) return; if (!start.moved && Math.abs(event.clientX - start.x) < 4) return; if (!start.moved) { start.moved = true; setDragging(true); } turn(start.angle + (event.clientX - start.x) * .6); }}
      onPointerUp={() => { const click = drag.current && !drag.current.moved; drag.current = null; setDragging(false); if (click) onOpenChange(!open); }} onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onKeyDown={event => {
        if (event.key === "ArrowLeft") turn(angle - 15);
        else if (event.key === "ArrowRight") turn(angle + 15);
        else if (event.key === "Home") setAngle(0);
        else if (event.key === "Enter" || event.key === " ") onOpenChange(!open);
        else return;
        event.preventDefault(); event.stopPropagation();
      }}>
      <span className="k-back"><span className="ins">{face(data.back, "뒷면")}</span></span>
      <span className="k-floor">{data.platform === "sw" || data.platform === "sw2" ? <span className="cart-slot"><span className="cart" /></span> : <span className="holder"><span className="disc" /></span>}{note && <div className="note">{note}</div>}</span>
      <span className="k-edge" /><span className="k-cap k-top" /><span className="k-cap k-bottom" />
      <span className="k-hinge"><span className="k-spine"><span className={spineInsertClass(data)}>
        <CaseSpine data={data} real={face(data.spine, "책등")} />
      </span></span><span className="k-spine-in" /><span className="k-lid"><span className="k-front"><span className="ins">{face(data.front, "앞면")}</span></span><span className="k-inner">{inside}</span></span></span>
    </div>
  </div>;
}

/** Both the work case and the light shelf case use the same package printing. */
export function CaseSpine({ data, real, decorative = false }: { data: CaseData; real?: ReactNode; decorative?: boolean }) {
  const template = ["sw2", "sw", "ps5"].includes(data.platform);
  const title = <span className="spine-title" data-title={decorative ? data.title : undefined}>{decorative ? null : data.title}</span>;
  return <span className="case-spine-art">{data.privacy ? <span className="case-mask" /> : data.spine ? real : template ?
    <span className={`tpl ${data.platform}`} data-spine-template={data.platform} data-nintendo={/nintendo|닌텐도/i.test(data.publisher ?? "") ? "" : undefined}>
      <span className="t-head" /><span className="t-band">{title}</span><span className="t-foot"><span className="t-pub">{data.publisher}</span></span>
    </span> : title}</span>;
}
