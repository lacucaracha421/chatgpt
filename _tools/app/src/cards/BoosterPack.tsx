import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { usePrivacy } from "../privacy/PrivacyContext";
import { assetMasked } from "../shared/privacy/contentMask";
import { composePackCover } from "./packCover";
import { createPointerTilt, useCardReducedMotion } from "./motion";
import { mark, printVariables } from "./printAssets";
import { completesTear, tearProgress, type PackCover } from "./types";
import "./cards.css";
import "./opening.css";

export interface BoosterPackProps {
  cover?: PackCover;
  cardCount?: number;
  onOpened?: () => void;
  onTearStart?: () => void;
  resetToken?: number;
  disabled?: boolean;
}
const emptyCover: PackCover = { imageUrls: [] };

export function BoosterPack({ cover: suppliedCover = emptyCover, cardCount = 5, onOpened, onTearStart, resetToken = 0, disabled = false }: BoosterPackProps) {
  const { privacyMode, nsfwFilter, ratings, requestRating } = usePrivacy();
  useEffect(() => { suppliedCover.assetIds?.forEach(requestRating); }, [suppliedCover, requestRating]);
  const maskCover = privacyMode || (nsfwFilter && (!suppliedCover.assetIds?.length || suppliedCover.assetIds.some(id => assetMasked(false, true, { contentRating: ratings.get(id) }))));
  const cover = useMemo(() => maskCover ? emptyCover : suppliedCover, [maskCover, suppliedCover]);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: number; last: number; time: number; velocity: number; progress: number } | null>(null);
  const opened = useRef(false);
  const [url, setUrl] = useState("");
  const [ready, setReady] = useState(false);
  const reduced = useCardReducedMotion();
  useEffect(() => {
    opened.current = false; drag.current = null;
    root.current?.classList.remove("auto", "torn", "drag");
    root.current?.style.setProperty("--tear", "0");
  }, [resetToken]);
  useEffect(() => { let live = true; composePackCover(cover).then(value => { if (live) { setUrl(value); setReady(true); } }).catch(() => { if (live) { setUrl(""); setReady(true); } }); return () => { live = false; }; }, [cover]);
  useEffect(() => {
    const node = root.current!; const tilt = createPointerTilt(node, reduced);
    const move = (event: globalThis.PointerEvent) => { if (!drag.current && !opened.current) tilt.move(event.clientX, event.clientY); };
    node.addEventListener("pointermove", move); node.addEventListener("pointerleave", tilt.reset);
    return () => { node.removeEventListener("pointermove", move); node.removeEventListener("pointerleave", tilt.reset); tilt.reset(); };
  }, [reduced]);
  const open = () => {
    if (opened.current || disabled) return;
    onTearStart?.();
    opened.current = true; drag.current = null;
    root.current!.classList.remove("drag", "hov", "active"); root.current!.classList.add("auto", "torn"); root.current!.style.setProperty("--tear", "1"); onOpened?.();
  };
  const cancel = () => { if (opened.current) return; drag.current = null; root.current!.classList.remove("drag"); root.current!.style.setProperty("--tear", "0"); };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (opened.current || disabled || drag.current || (event.button !== 0 && event.pointerType === "mouse")) return;
    onTearStart?.();
    event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { id: event.pointerId, start: event.clientX, last: event.clientX, time: event.timeStamp, velocity: 0, progress: 0 }; root.current!.classList.add("drag");
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current; if (!state || state.id !== event.pointerId) return;
    state.velocity = state.velocity * .6 + .4 * (event.clientX - state.last) / Math.max(1, event.timeStamp - state.time);
    state.last = event.clientX; state.time = event.timeStamp;
    state.progress = tearProgress(event.clientX - state.start, root.current!.getBoundingClientRect().width);
    root.current!.style.setProperty("--tear", String(state.progress)); if (completesTear(state.progress)) open();
  };
  const face = <><div className="pk-bg" /><div className={`pk-col${maskCover ? " privacy-mask" : ""}`}>{url && !maskCover && <img src={url} alt="" draggable={false} />}</div>
    {!cover.imageUrls.length && !cover.centreCutoutUrl && <div className="pk-emb"><svg viewBox="0 0 32 36"><path d={mark} fill="#e2c98a" /></svg></div>}
    <div className="pk-tags"><span><span className="pk-code">LKM-01</span><b className="pk-name">라쿠믹스</b></span><span><span className="pk-brand">LAKOMICS</span><span className="pk-age">수집용</span><i className="pk-kind">부스터 팩</i></span></div>
    <div className="pk-title"><i>수집의 밤</i><i>수집의 밤</i><i>수집의 밤</i></div>
    <div className="pk-sub"><b><i>LAKOMICS</i><i>LAKOMICS</i></b><span>CARD COLLECTION</span><em>라쿠믹스 카드 컬렉션</em></div>
    <div className="pk-strip"><span className="row"><span className="pk-total">카드 컬렉션</span><span className="pk-cnt">1팩 <b>{cardCount}장</b> 들이</span></span><small className="pk-legal">© Lakomics · 개인 수집용 · LKM-01</small><span className="pk-marks"><span><svg viewBox="0 0 32 36"><path d={mark} /></svg></span><span>수집<br />전용</span></span></div>
    <div className="pk-wrinkle" /><div className="pk-pillow" /><div className="pk-crimp t" /><div className="pk-crimp b" /></>;
  return <div className="lkm-cards booster-pack" style={printVariables}><div ref={root} className={`pack live${cover.imageUrls.length ? "" : " art-none"}`} style={{ opacity: ready ? 1 : 0 } as CSSProperties}>
    <div className="pk-shadow" /><div className="pk-tilt" aria-hidden="true"><div className="pack-body"><div className="pk-face">{face}</div></div><div className="pack-top"><div className="tp tp-att"><div className="tp-in"><div className="pk-face">{face}</div></div></div><div className="tp tp-peel"><div className="tp-in"><div className="pk-face">{face}</div></div></div></div><div className="pack-leak" /><div className="pk-sheen"><i /><b /></div></div>
    <div className="pk-grip" role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={`${cardCount}장 팩 뜯기. 윗 띠를 오른쪽으로 밀거나 Enter로 뜯기`}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }} onPointerDown={down} onPointerMove={move}
      onPointerUp={event => { const state = drag.current; if (state?.id === event.pointerId) { const velocity = event.timeStamp - state.time > 100 ? 0 : state.velocity; if (completesTear(state.progress, velocity)) open(); else cancel(); } }}
      onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }} />
    {!disabled && <p className="pk-hint" aria-hidden="true"><b>›</b>밀어서 뜯기</p>}
  </div></div>;
}
