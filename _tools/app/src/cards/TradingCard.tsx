import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { BackFace } from "./CardBack";
import { renderBackground, type BackgroundVariant } from "./backgrounds";
import { createPointerTilt, useCardReducedMotion } from "./motion";
import { printVariables } from "./printAssets";
import { frameTexture } from "./frameTexture";
import { luminanceMask } from "./luminance";
import { hasCutoutLayer, tierClass, tierRank, type CardData } from "./types";
import "./cards.css";
import { useAssetMask } from "../privacy/PrivacyContext";
import { StableImage } from "../shared/ui/StableImage";

/** The pop-out layer exists only for SSR/UR/LR; any other tier keeps the full-art look. */
const cutoutOf = (card: CardData) => hasCutoutLayer(card.tier) ? card.cutoutUrl : undefined;

function background(card: CardData) {
  if (!cutoutOf(card)) return card.artUrl;
  const variants: BackgroundVariant[] = ["digital", "ribbon", "ornament", "aurora"];
  const hash = [...card.id].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0;
  try { return renderBackground(variants[(hash + tierRank(card.tier)) % 4], card.tier, card.tint || "#6a3aa8"); }
  catch { return card.artUrl; }
}

export interface TradingCardProps {
  card: CardData;
  faceDown?: boolean;
  onReveal?: () => void;
}

export function TradingCard({ card, faceDown = false, onReveal }: TradingCardProps) {
  const masked = useAssetMask(card.artAssetId);
  const rarityId = useId();
  const host = useRef<HTMLDivElement>(null);
  const reduced = useCardReducedMotion();
  const [teasing, setTeasing] = useState(false);
  const cutout = cutoutOf(card);
  const art = useMemo(() => masked ? "" : background(card), [card, masked]);
  useEffect(() => {
    const node = host.current!; let live = true;
    node.style.removeProperty("--lum");
    if (!masked && !cutout) void luminanceMask(card.artUrl).then(mask => { if (live && mask) node.style.setProperty("--lum", mask); });
    return () => { live = false; };
  }, [card.artUrl, cutout, masked]);
  const frame = useMemo(() => {
    if (card.tier !== "n" && card.tier !== "r") return undefined;
    try { return `url("${frameTexture(card.tier)}")`; } catch { return undefined; }
  }, [card.tier]);
  useEffect(() => {
    const node = host.current!;
    const tilt = createPointerTilt(node, reduced);
    const move = (event: PointerEvent) => tilt.move(event.clientX, event.clientY);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", tilt.reset);
    return () => { node.removeEventListener("pointermove", move); node.removeEventListener("pointerleave", tilt.reset); tilt.reset(); };
  }, [reduced]);
  const rank = tierRank(card.tier);
  const power = Math.max(500, Math.floor(card.artWidth * card.artHeight / 1e6 * 2) * 500);
  const style = { ...printVariables, "--tint": card.tint || "#6a3aa8", "--c2": card.tint || "#6a3aa8" } as CSSProperties;
  return <div className="lkm-cards trading-card" style={style} data-reduced-motion={reduced}>
    <div ref={host} className={`card ${tierClass(card.tier)}${faceDown ? " down" : " revealed"}${teasing && faceDown ? " hover" : ""}${reduced ? " xfade" : ""}`}
      data-tier={card.tier} data-cut={cutout ? "1" : "0"} data-subj={cutout ? "1" : "0"} data-samebg={cutout ? "0" : "1"}
      role={onReveal ? "button" : "img"} tabIndex={onReveal ? 0 : undefined}
      aria-label={faceDown ? "카드 뒤집기" : `${card.tier.toUpperCase()} ${card.characterName}, ${card.seriesName}, 보유 ${card.count}장, 레벨 ${card.level}`}
      onClick={() => { if (faceDown) onReveal?.(); }}
      onKeyDown={event => { if (faceDown && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onReveal?.(); } }}
      onPointerEnter={() => setTeasing(true)} onPointerLeave={() => setTeasing(false)} onPointerDown={() => setTeasing(true)} onPointerUp={() => setTeasing(false)} onPointerCancel={() => setTeasing(false)}
      onFocus={() => setTeasing(true)} onBlur={() => setTeasing(false)}>
      <div className="card__flip"><div className="card__tilt">
        <div className="face front" aria-hidden={faceDown}>
          {masked ? <span className="f-bg privacy-mask" aria-label="이미지 숨김" /> : art && <StableImage className="f-bg" src={art} alt="" draggable={false} respectReducedMotion />}
          <div className="f-sheen" /><div className="f-etch" /><div className="f-shade" /><div className="f-frame" style={{ backgroundImage: frame }} /><div className="f-glare" /><div className="f-rainbow" /><div className="f-depth" />
          {!masked && cutout && <div className="f-subjwrap"><StableImage className="f-subj" src={cutout} alt="" draggable={false} respectReducedMotion /></div>}
          <div className="f-motes">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ left: `${6 + i * 37 % 86}%`, top: `${42 + i * 23 % 52}%`, "--d": `${7 + i * 7 % 5}s`, "--w": `${-i * .83}s` } as CSSProperties} />)}</div>
          <div className="f-cost"><span className="num">{rank + 1}</span></div>
          <div className={`f-dup${card.count > 9 ? " two" : ""}`}><span className="num">{card.count}</span></div>
          <div className="f-power"><b className="num">{power >= 1000 ? Math.floor(power / 1000) : power}</b><span className="pw-tail"><i>PW</i>{power >= 1000 && <small className="num">{String(power % 1000).padStart(3, "0")}</small>}</span></div>
          <div className="f-gem"><span className="f-type"><svg viewBox="0 0 24 24"><path d="m12 3 7 9-7 9-7-9z" /></svg></span></div>
          <div className="f-fx"><div className="fx"><span className="kw">시리즈</span><span className="tx">{card.seriesName}</span></div><div className="fx"><span className="kw">수집</span><span className="tx">보유 {card.count}장 · 레벨 {card.level}</span></div></div>
          <div className="f-nb"><span className="nb-lv"><i>Lv.</i><b className="num">{card.level}</b></span><span className={`f-title${card.tier === "sr" ? " emboss" : ""}`}>{card.characterName}</span><span className="nb-no"><span>{card.id}</span><span className="f-rar">
            {rank === 0 ? "●" : Array.from({ length: rank >= 3 ? rank - 2 : rank }, (_, i) => <svg key={i} viewBox="0 0 20 20" aria-hidden="true" style={{ fill: `url(#${rarityId}-${i})` }}>
              <defs><linearGradient id={`${rarityId}-${i}`}><stop stopColor={rank >= 3 ? "#a8711c" : "#8a929c"} /><stop offset=".35" stopColor={rank >= 3 ? "#fff3c8" : "#fff"} /><stop offset=".7" stopColor={rank >= 3 ? "#c88d2a" : "#9aa2ac"} /><stop offset="1" stopColor={rank >= 3 ? "#ffe9a6" : "#f4f6f8"} /></linearGradient></defs>
              <path d="m10 1 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3L10 15.4l-5.6 2.9 1.1-6.3L1 7.6l6.2-.9Z" />
            </svg>)}<span>{card.tier.toUpperCase()}</span>
          </span></span></div>
          <div className="f-traits">{card.serial && rank >= 4 && <span className="f-serial">{card.serial}</span>}<span className="t">{card.seriesName}</span></div>
          <div className="f-vc">© Lakomics · 카드 컬렉션</div>{card.tier === "lr" && card.serial && <div className="f-ser2">한정 · {card.serial}</div>}
        </div><BackFace />
      </div></div>
      <span className="rim" aria-hidden="true"><i /></span>
      {!faceDown && card.isNew && <span className="new-tag">NEW</span>}
      {!faceDown && card.tier === "lr" && reduced && <span className="lr-banner">LR · 별빛 한정</span>}
    </div>
  </div>;
}
