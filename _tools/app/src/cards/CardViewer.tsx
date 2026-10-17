import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useAssetMask } from "../privacy/PrivacyContext";
import { displayDate } from "../shared/displayDate";
import { preloadImages } from "../shared/motion/viewportImages";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { IconButton } from "../shared/ui/IconButton";
import { StableImage } from "../shared/ui/StableImage";
import { useCardReducedMotion } from "./motion";
import { TradingCard } from "./TradingCard";
import { hasCutoutLayer, type CardData } from "./types";
import "./viewer.css";

/** How long the old card stays under the new one while they cross-fade. Matches viewer.css. */
export const CARD_VIEWER_FADE_MS = 240;
const PRELOAD_CAP_MS = 2000;
/** A flick: far enough, mostly sideways, and quick. Slower drags only tilt the card. */
const SWIPE_MIN_PX = 64, SWIPE_MAX_MS = 450;

const artUrls = (card: CardData) => [card.artUrl, ...(card.cutoutUrl ? [card.cutoutUrl] : [])].filter(Boolean);
/** Waits (bounded) until the card art is decoded, so a card never appears half-painted. */
export const preloadCard = (card: CardData) => preloadImages(artUrls(card), PRELOAD_CAP_MS);

export interface CardViewerProps {
  /** The album's current, filtered list. The viewer walks through exactly these cards. */
  cards: readonly CardData[];
  /** Position of the card to show in `cards`. */
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onOpenAsset?: (assetId: string) => void;
  onCharacter?: (characterId: string) => void;
  albumAction?: (card: CardData) => ReactNode;
  /** Tests replace the image preparation; the default decodes the art. */
  preload?: (card: CardData) => Promise<unknown>;
  /**
   * A sharper copy of a card's art for the big card and 그림 보기, or "" when there is none. The tablet's
   * album art is its 360 px thumbnail, which the full-window card enlarges 4-9 times.
   */
  sharpArt?: (card: CardData) => Promise<string>;
}

/** The card with its sharper art, once decoded. A cutout card's face is generated, so only 그림 보기 changes. */
const withSharp = (card: CardData, sharp: ReadonlyMap<string, string>) => {
  const url = sharp.get(card.id);
  return url && !(hasCutoutLayer(card.tier) && card.cutoutUrl) ? { ...card, artUrl: url } : card;
};

/**
 * Full-window card viewer shared by the PC and tablet albums: the card as large as fits, with tilt,
 * foil and pop-out, stepping through the album list. The current card stays on screen until the
 * next one has its art decoded, then the two cross-fade (reduced motion: instant swap).
 */
export function CardViewer({ cards, index, onIndexChange, onClose, onOpenAsset, onCharacter, albumAction, preload = preloadCard, sharpArt }: CardViewerProps) {
  const reduced = useCardReducedMotion();
  const target = cards[index] ?? cards[0];
  const [shown, setShown] = useState<CardData>(target);
  const [leaving, setLeaving] = useState<CardData | null>(null);
  const [info, setInfo] = useState(true), [art, setArt] = useState(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (target.id === shownRef.current.id) { setShown(target); return; }
    let live = true;
    void Promise.resolve(preload(target)).catch(() => undefined).then(() => {
      if (!live) return;
      setLeaving(reduced ? null : shownRef.current);
      setShown(target);
    });
    return () => { live = false; };
  }, [target, reduced, preload]);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), CARD_VIEWER_FADE_MS + 40);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  // Sharper art replaces the thumbnail only after it is decoded, so the card never blanks or blurs back.
  const [sharp, setSharp] = useState<ReadonlyMap<string, string>>(() => new Map());
  const asked = useRef(new Set<string>());
  const sharpen = useCallback((card: CardData) => {
    if (!sharpArt || asked.current.has(card.id)) return;
    asked.current.add(card.id);
    void sharpArt(card).then(async url => {
      if (!url || url === card.artUrl) return;
      await preload({ ...card, artUrl: url, cutoutUrl: undefined });
      setSharp(old => new Map(old).set(card.id, url));
    }).catch(() => { asked.current.delete(card.id); });
  }, [sharpArt, preload]);
  useEffect(() => { sharpen(shown); }, [shown, sharpen]);
  // Neighbours are decoded ahead so stepping is immediate.
  useEffect(() => {
    for (const card of [cards[index + 1], cards[index - 1]]) if (card) { void Promise.resolve(preload(card)).catch(() => undefined); sharpen(card); }
  }, [cards, index, preload, sharpen]);
  const shownFace = useMemo(() => withSharp(shown, sharp), [shown, sharp]);
  const leavingFace = useMemo(() => leaving && withSharp(leaving, sharp), [leaving, sharp]);

  const step = useCallback((delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < cards.length) onIndexChange(next);
  }, [cards.length, index, onIndexChange]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
  };

  const swipe = useRef<{ x: number; y: number; at: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swipe.current = event.pointerType === "mouse" ? null : { x: event.clientX, y: event.clientY, at: event.timeStamp };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipe.current; swipe.current = null;
    if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5 && event.timeStamp - start.at <= SWIPE_MAX_MS) step(dx < 0 ? 1 : -1);
  };
  // A sideways trackpad swipe steps cards here instead of reaching the Dialog's swipe-to-close.
  const wheel = useRef({ sum: 0, until: 0 });
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.stopPropagation();
    const state = wheel.current, now = performance.now();
    if (now < state.until) return;
    if (Math.sign(event.deltaX) !== Math.sign(state.sum)) state.sum = 0;
    state.sum += event.deltaX;
    if (Math.abs(state.sum) < 80) return;
    step(state.sum > 0 ? 1 : -1);
    state.sum = 0; state.until = now + 450;
  };
  /** A tap on the empty backdrop (not on the card or a control) shows or hides the info. */
  const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
    const hit = event.target as HTMLElement;
    if (hit === event.currentTarget || hit.classList.contains("card-viewer__layer")) setInfo(value => !value);
  };

  const masked = useAssetMask(shown.artAssetId);
  const position = Math.max(0, cards.findIndex(card => card.id === shown.id));
  const tier = shown.tier.toUpperCase();
  const canAsset = !!onOpenAsset && !!shown.artAssetId, canCharacter = !!onCharacter && !!shown.characterId;
  return <Dialog open title={`${shown.characterName} ${tier} 크게 보기`} variant="fullscreen" onClose={onClose} onKeyDown={onKeyDown}>
    <div className="card-viewer" onWheel={onWheel} data-reduced={reduced} data-info={info} data-art={art}>
      <div className="card-viewer__stage" onClick={onStageClick} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { swipe.current = null; }}>
        {art ? <div className="card-viewer__layer card-viewer__layer--art">
          {masked ? <span className="card-viewer__art privacy-mask" role="img" aria-label="이미지 숨김" />
            : <StableImage className="card-viewer__art" src={sharp.get(shown.id) ?? shown.artUrl} alt={`${shown.characterName} 원본 그림`} draggable={false} respectReducedMotion />}
        </div> : <>
          {leavingFace && <div key={`out:${leavingFace.id}`} className="card-viewer__layer card-viewer__layer--out" aria-hidden="true"><div className="card-viewer__card"><TradingCard card={leavingFace} /></div></div>}
          <div key={`in:${shown.id}`} className="card-viewer__layer card-viewer__layer--in"><div className="card-viewer__card" data-viewer-card><TradingCard card={shownFace} /></div></div>
        </>}
      </div>
      <header className="card-viewer__bar" data-tauri-drag-region="deep"
        onPointerDown={event => event.stopPropagation()}
        onPointerMove={event => event.stopPropagation()}
        onPointerUp={event => event.stopPropagation()}
        onPointerCancel={event => event.stopPropagation()}>
        <span className="card-viewer__count" aria-live="polite">{position + 1} / {cards.length}</span>
        <Button className="card-viewer__art-toggle" variant="quiet" aria-pressed={art} onClick={() => setArt(value => !value)}><PhotoIcon aria-hidden="true" />{art ? "카드 보기" : "그림 보기"}</Button>
        <IconButton className="card-viewer__close" label="닫기" icon={XMarkIcon} onClick={onClose} />
      </header>
      <IconButton className="card-viewer__nav card-viewer__nav--prev" label="이전 카드" icon={ChevronLeftIcon} disabled={index <= 0} onClick={() => step(-1)} />
      <IconButton className="card-viewer__nav card-viewer__nav--next" label="다음 카드" icon={ChevronRightIcon} disabled={index >= cards.length - 1} onClick={() => step(1)} />
      <footer className="card-viewer__info" data-open={info} aria-label="카드 정보">
        <div className="card-viewer__title"><h2>{shown.characterName}</h2><p>{shown.seriesName}</p></div>
        <dl>
          <div><dt>등급</dt><dd>{tier}</dd></div>
          <div><dt>보유</dt><dd>{shown.count}장</dd></div>
          <div><dt>레벨</dt><dd>Lv.{shown.level}</dd></div>
          <div><dt>처음 뽑음</dt><dd>{displayDate(shown.firstDrawnAt) || "—"}</dd></div>
          {shown.serial && <div><dt>일련번호</dt><dd>{shown.serial}</dd></div>}
        </dl>
        {(canAsset || canCharacter || albumAction) && <div className="card-viewer__actions">
          {canAsset && <Button onClick={() => onOpenAsset!(shown.artAssetId!)}>원본 열기</Button>}
          {canCharacter && <Button variant="quiet" onClick={() => onCharacter!(shown.characterId!)}>캐릭터 폴더</Button>}
          {albumAction?.(shown)}
        </div>}
      </footer>
    </div>
  </Dialog>;
}
