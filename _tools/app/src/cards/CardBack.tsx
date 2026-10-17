import { useId } from "react";
import type { CardTier } from "./types";
import { printVariables } from "./printAssets";
import "./cards.css";
import "./opening.css";

/** The print is identical at every tier; only interaction exposes the tease. */
export function BackFace() {
  const ring = useId();
  return <div className="face back" aria-hidden="true">
    <div className="f-plate">
      <div className="b-art" />
      <svg className="b-ring" viewBox="0 0 630 880"><defs><path id={ring} d="M93 440a222 284 0 1 1 444 0a222 284 0 1 1 -444 0" /></defs>
        <text fill="currentColor"><textPath href={`#${ring}`} textLength="1586" lengthAdjust="spacing">{"LAKOMICS · ASSET CARD · ".repeat(7)}</textPath></text>
      </svg>
      <div className="b-logo"><span>LAKOMICS</span><span className="dn">LAKOMICS</span></div>
      <div className="b-tint" /><div className="b-gold" /><div className="b-print" /><div className="b-sheen" />
    </div>
  </div>;
}

export function CardBack({ teaseTier = "n", teasing = false }: { teaseTier?: CardTier; teasing?: boolean }) {
  return <div className="lkm-cards" style={printVariables}><div className={`card down${teasing ? " hover" : ""}`} data-tier={teaseTier} aria-label="카드 뒷면">
    <div className="card__flip"><div className="card__tilt"><BackFace /></div></div>
    <span className="rim" aria-hidden="true"><i /></span>
  </div></div>;
}
