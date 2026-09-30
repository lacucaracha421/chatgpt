import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./CollectionCase.css";

export type CasePlatform = "sw2" | "sw" | "ps5" | "pc" | "other" | "av";
export function casePlatform(platforms: string | null): CasePlatform {
  if (/switch\s*2/i.test(platforms ?? "")) return "sw2";
  if (/switch/i.test(platforms ?? "")) return "sw";
  if (/ps5|playstation\s*5/i.test(platforms ?? "")) return "ps5";
  if (/pc|windows/i.test(platforms ?? "")) return "pc";
  return "other";
}
const PLASTIC: Record<CasePlatform, string> = {
  sw2: "rgba(206,44,54,.9)", sw: "rgba(214,222,230,.24)", ps5: "rgba(214,222,230,.24)",
  pc: "rgba(120,128,136,.38)", other: "rgba(120,128,136,.38)", av: "rgba(10,10,11,.94)",
};
export type CaseData = { title: string; publisher?: string | null; platform: CasePlatform; front: string | null; spine?: string | null; back?: string | null; privacy: boolean };
export type Fact = [string, string];
export function CaseFacts({ rows }: { rows: Fact[] }) {
  return <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function CaseInside({ record, facts, memo }: { record: Fact[]; facts: Fact[]; memo?: string | null }) {
  return <><span className="clip clip-one" /><span className="clip clip-two" /><div className="slip"><b>내 기록</b><CaseFacts rows={record} />{memo && <p>{memo}</p>}</div><div className="card2"><b>작품 정보</b><CaseFacts rows={facts} /></div></>;
}
export function CollectionCase({ data, open, onOpenChange, frontReset = 0, inside, note, onReady, large = false }: {
  data: CaseData; open: boolean; onOpenChange(open: boolean): void; frontReset?: number;
  inside?: ReactNode; note?: ReactNode; onReady?(): void; large?: boolean;
}) {
  const [angle, setAngle] = useState(open ? -10 : 28);
  const [ratio, setRatio] = useState(.71);
  const savedAngle = useRef(28);
  const drag = useRef<{ x: number; angle: number } | null>(null);
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
  const template = ["sw2", "sw", "ps5"].includes(data.platform);
  return <div className={`collection-case${large ? " collection-case--large" : ""}${open ? " is-open" : ""}`} style={{ "--ratio": ratio, "--plastic": PLASTIC[data.platform] } as CSSProperties}>
    <span className="floor-shadow" aria-hidden="true" />
    {/* This control is the physical media object, with rotation distinct from screen navigation. */}
    <div className="kase" tabIndex={0} role="group" aria-label="케이스" aria-expanded={open} data-angle={angle} style={{ "--ry": `${angle}deg`, "--open": open ? 1 : 0, "--gloss": `${50 + angle}%` } as CSSProperties}
      onPointerDown={event => { if (event.button !== 0) return; drag.current = { x: event.clientX, angle }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { if (drag.current) turn(drag.current.angle + (event.clientX - drag.current.x) * .6); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => onOpenChange(!open)} onKeyDown={event => {
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
      <span className="k-hinge"><span className="k-spine"><span className={`ins${data.spine || data.privacy ? "" : template ? " full" : " bare"}`}>
        {data.spine || data.privacy ? face(data.spine, "책등") : template ? <span className={`tpl ${data.platform}`} data-spine-template={data.platform}><span className="t-head" /><span className="t-band"><span className="spine-title">{data.title}</span></span><span className="t-foot"><span className="t-pub">{data.publisher}</span></span></span> : <span className="spine-title">{data.title}</span>}
      </span></span><span className="k-spine-in" /><span className="k-lid"><span className="k-front"><span className="ins">{face(data.front, "앞면")}</span></span><span className="k-inner">{inside}</span></span></span>
    </div>
  </div>;
}
