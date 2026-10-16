import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ImageTextLine } from "../../library/types";
import { reducedMotion, EASE_STANDARD } from "../motion/curves";
import { layoutImageTextNotes, lineGeometry, type ImageRect, type ImageZoom } from "./imageTextNoteLayout";
import "./image-text.css";

export type ImageTextNotesHandle = { tap: (clientX: number, clientY: number) => boolean; dismissCard: () => boolean };
const browserCopy = (text: string) => navigator.clipboard.writeText(text);

export const ImageTextNotes = forwardRef<ImageTextNotesHandle, {
  lines: ImageTextLine[]; selected: number | null; open: boolean; onSelect: (index: number) => void;
  rect: ImageRect; zoom: ImageZoom; panning?: boolean; animatePan?: boolean; interactive?: boolean;
  surfaceTap?: boolean; onCopy?: (text: string) => Promise<void>;
}>(function ImageTextNotes({ lines, selected, open, onSelect, rect, zoom, panning = false, animatePan = false, interactive = true, surfaceTap = false, onCopy = browserCopy }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(() => ({ lines, scale: zoom.scale, notes: layoutImageTextNotes(lines, rect.width * zoom.scale, rect.height * zoom.scale, (word, font) => word.length * font) }));
  const [hovered, setHovered] = useState<number | null>(null);
  const [card, setCard] = useState<number | null>(null);
  const [copyState, setCopyState] = useState("");
  const cardElement = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(200);
  useLayoutEffect(() => { if (cardElement.current) setCardHeight(cardElement.current.offsetHeight || 200); }, [card, copyState]);
  useLayoutEffect(() => {
    if (panning && layout.lines === lines) return;
    // Measure whole words using the same font as the displayed notes, without reading the image.
    const probe = document.createElement("span");
    probe.style.cssText = "position:fixed;visibility:hidden;white-space:pre;font-family:var(--font-ui);font-weight:600;letter-spacing:0;";
    document.body.append(probe);
    const widths = new Map<string, number>();
    const notes = layoutImageTextNotes(lines, rect.width * zoom.scale, rect.height * zoom.scale, (word, font) => {
      const key = `${font}:${word}`;
      const cached = widths.get(key);
      if (cached !== undefined) return cached;
      probe.style.fontSize = `${font}px`; probe.textContent = word;
      const width = probe.getBoundingClientRect().width || [...word].reduce((sum, char) => sum + (/[^\u0000-\u007f]/.test(char) ? font : font * .55), 0);
      widths.set(key, width);
      return width;
    });
    probe.remove();
    setLayout({ lines, scale: zoom.scale, notes });
  }, [lines, rect.width, rect.height, zoom.scale, panning]);
  useLayoutEffect(() => { setCard(null); setCopyState(""); setHovered(null); }, [lines, open, interactive]);
  useLayoutEffect(() => { if (selected !== card) setCard(null); }, [selected]);
  const hasNotes = layout.notes.length > 0;
  useLayoutEffect(() => {
    if (open && hasNotes && !reducedMotion()) root.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: EASE_STANDARD });
  }, [open, hasNotes]);
  const activate = (index: number) => { onSelect(index); setCard(current => current === index ? null : index); setCopyState(""); };
  const left = rect.left + rect.width / 2 + zoom.x - rect.width * zoom.scale / 2;
  const top = rect.top + rect.height / 2 + zoom.y - rect.height * zoom.scale / 2;
  const ratio = zoom.scale / layout.scale;
  const raised = hovered ?? selected;
  const zIndex = (index: number, base = 1) => raised === index ? lines.length + 3 : base;
  const dismissCard = () => {
    if (card === null) return false;
    setCard(null);
    root.current?.querySelector<HTMLButtonElement>(`[data-line-note="${card}"]`)?.focus();
    return true;
  };
  useImperativeHandle(ref, () => ({ tap(clientX, clientY) {
    if (!open || !interactive || !root.current) return false;
    const stage = root.current.parentElement!.getBoundingClientRect();
    const x = (clientX - stage.left - left) / ratio, y = (clientY - stage.top - top) / ratio;
    const hit = [...layout.notes].sort((a, b) => zIndex(b.index, b.zIndex) - zIndex(a.index, a.zIndex)).find(note => x >= note.x && x <= note.x + note.w && y >= note.y && y <= note.y + note.h);
    if (!hit) return false;
    activate(hit.index); return true;
  }, dismissCard }));
  const note = layout.notes.find(item => item.index === card);
  const line = card !== null ? lines[card] : null;
  const W = rect.width * layout.scale, H = rect.height * layout.scale;
  // Older saved translations legitimately have no OCR coordinates. Keep them readable
  // in a viewport-bound list rather than inventing anchors or silently dropping them.
  const unpositioned = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.korean.trim() && !lineGeometry(line, 1000, 1000));
  // Clamp the card to the visible viewport as well as the image, including zoomed images.
  const stage = root.current?.parentElement;
  const viewLeft = Math.max(0, -left / ratio), viewTop = Math.max(0, -top / ratio);
  const viewRight = Math.min(W, ((stage?.clientWidth || rect.width) - left) / ratio);
  const viewBottom = Math.min(H, ((stage?.clientHeight || rect.height) - top) / ratio);
  const cardWidth = Math.max(0, Math.min(260, viewRight - viewLeft));
  const cardMaxHeight = Math.max(0, viewBottom - viewTop);
  const visibleCardHeight = Math.min(cardHeight, cardMaxHeight);
  const cardTop = note ? (note.y + note.h + 4 + visibleCardHeight <= viewBottom ? note.y + note.h + 4 : note.y - visibleCardHeight - 4) : 0;
  return <><div ref={root} className="image-text-notes" role="group" aria-label="이미지 글자 번역" data-open={open} data-sized={W > 0 && H > 0} data-panning={panning} data-animate-pan={animatePan} data-surface-tap={surfaceTap} aria-hidden={!open} inert={!open || !interactive}
    onKeyDown={event => { if (event.key === "Escape" && dismissCard()) { event.preventDefault(); event.stopPropagation(); } }}
    style={{ left: 0, top: 0, width: W, height: H, transform: `translate(${left}px, ${top}px) scale(${ratio})` }}>
    {layout.notes.map(item => <button key={item.index} type="button" className="image-text-note" data-line-note={item.index} data-stacked={!!item.stacked} aria-label={`${item.index + 1}번 대사`} aria-pressed={selected === item.index}
      onPointerEnter={() => setHovered(item.index)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(item.index)} onBlur={() => setHovered(null)}
      onPointerDown={event => { if (!surfaceTap) event.stopPropagation(); }}
      onClick={() => activate(item.index)}
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, padding: `${item.padY}px ${item.padX}px`, fontSize: item.f, overflowWrap: item.wrap ? "anywhere" : "normal", zIndex: zIndex(item.index, item.zIndex) }}>{lines[item.index]?.korean}</button>)}
    {open && interactive && note && line && <div ref={cardElement} className="image-text-note-card ui-anchored-panel" role="region" aria-label="대사 번역" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); dismissCard(); } event.stopPropagation(); }}
      style={{ left: Math.max(viewLeft, Math.min(note.x, viewRight - cardWidth)), top: Math.max(viewTop, Math.min(cardTop, viewBottom - visibleCardHeight)), width: cardWidth, maxHeight: cardMaxHeight, zIndex: lines.length + 4 }}>
      <span className="image-text-note-card__original">{line.original}</span><span>{line.korean}</span>
      <div><button type="button" onClick={() => setCard(null)} aria-label="번역 카드 닫기">닫기</button><button type="button" onClick={async () => {
        try { await onCopy(line.korean); setCopyState("복사됨"); } catch { setCopyState("복사하지 못했습니다. 다시 시도해 주세요."); }
      }}>복사</button></div>{copyState && <span role="status">{copyState}</span>}
    </div>}
  </div>
    {open && unpositioned.length > 0 && <div className="image-text-unpositioned ui-anchored-panel" role="region" aria-label="위치 없는 번역" inert={!interactive}
      onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <ol className="image-text-section__lines">
        {unpositioned.map(({ line, index }) => <li key={index}>
          <button type="button" className="image-text-section__row" aria-pressed={selected === index} onClick={() => onSelect(index)}>
            <span className="image-text-section__number" data-positioned="false">{index + 1}</span>
            <span><span className="image-text-section__korean">{line.korean}</span><span className="image-text-section__original">{line.original}</span></span>
          </button>
        </li>)}
      </ol>
    </div>}
  </>;
});
