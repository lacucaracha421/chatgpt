import { stripPosition } from "./coverStrip";
import type { SpineBitmapSpec } from "./mangaSpineBitmapCache";

const PAPER = "#f4f1e9", DARK = "#242421";

/** Same bands and nominal print sizes as collectionWork.css's printed shelf spine. */
export function drawMangaSpine(spec: SpineBitmapSpec, art: HTMLImageElement | null, scan: HTMLImageElement | null, grain: HTMLImageElement) {
  const { height: h, print: p } = spec;
  const ratio = scan ? scan.naturalWidth / scan.naturalHeight : null;
  const w = ratio ? h * ratio : spec.width;
  const density = spec.scale * spec.dpr;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w * density)); canvas.height = Math.max(1, Math.ceil(h * density));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.scale(density, density);
  ctx.save();
  const font = (size: number, weight: number) => { ctx.font = `${weight} ${size * spec.zoom}px ${spec.font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; };
  const band = (top: number, height: number, draw: () => void) => {
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, w, height); ctx.clip(); draw(); ctx.restore();
  };
  const vertical = (text: string, top: number, height: number, size: number, weight: number, sideways = false) => {
    band(top, height, () => {
      font(size, weight);
      if (sideways) {
        ctx.translate(w / 2, top + height / 2); ctx.rotate(Math.PI / 2); ctx.fillText(text, 0, 0);
      } else {
        // text-orientation: upright; each upright character advances one em.
        const chars = Array.from(text), advance = size * spec.zoom;
        chars.forEach((char, index) => ctx.fillText(char, w / 2, top + height / 2 + (index - (chars.length - 1) / 2) * advance));
      }
    });
  };
  if (scan && !spec.privacy) {
    ctx.drawImage(scan, scan.naturalWidth * .03, 0, scan.naturalWidth * .94, scan.naturalHeight * .984, 0, 0, w, h);
  } else {
    if (!spec.privacy) {
      ctx.fillStyle = DARK; ctx.fillRect(0, 0, w, p * 1.15);
      band(0, p * 1.15, () => { font(spec.labelFont, 800); ctx.fillStyle = PAPER; ctx.fillText(spec.publisher ?? "", w / 2, p * 1.15 / 2); });
      ctx.fillStyle = spec.ink;
      vertical(spec.title, p * 1.6, h * .73 - p * 4.95, spec.titleFont, 800, !/[\u1100-\u11ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(spec.title));
      const artTop = h * .73 - p * 1.7, artHeight = h * .17;
      ctx.fillStyle = "#ebe7dd"; ctx.fillRect(0, artTop, w, artHeight);
      if (art) band(artTop, artHeight, () => {
        const fit = Math.max(w / art.naturalWidth, artHeight / art.naturalHeight);
        const aw = art.naturalWidth * fit, ah = art.naturalHeight * fit;
        const position = stripPosition(spec.focus, artHeight * art.naturalWidth / art.naturalHeight, spec.width) / 100;
        ctx.drawImage(art, (w - aw) * position, artTop + (artHeight - ah) / 2, aw, ah);
      });
      ctx.fillStyle = DARK;
      if (spec.authorFont >= 3) vertical(spec.author ?? "", h * .9 - p * 1.4, h * .1, spec.authorFont, 600);
      if (spec.publisherFont >= 3) vertical(spec.publisher ?? "", h - p * 1.2, p * 1.2, spec.publisherFont, 800);
    }
    const numberTop = h * .73 - p * 3;
    if (!spec.privacy) {
      ctx.fillStyle = spec.ink; ctx.fillRect(w * .12, numberTop, w * .76, p);
      ctx.save(); ctx.globalAlpha *= spec.numberMix / 100; ctx.fillStyle = DARK; ctx.fillRect(w * .12, numberTop, w * .76, p); ctx.restore();
    }
    band(numberTop, p, () => {
      ctx.beginPath(); ctx.rect(w * .12, numberTop, w * .76, p); ctx.clip();
      font(p * .7, 800); ctx.fillStyle = spec.privacy ? "#b9b6ae" : PAPER;
      const digits = Array.from(String(spec.number));
      const advance = Math.max(...Array.from("0123456789", digit => ctx.measureText(digit).width));
      digits.forEach((digit, index) => ctx.fillText(digit, w / 2 + (index - (digits.length - 1) / 2) * advance, numberTop + p / 2));
    });
  }
  ctx.restore();
  // CSS fades each complete printed band, including its children, over opaque paper.
  // Apply opacity to the completed print, not separately to overlapping background/text pixels.
  if (spec.opacity !== 1) {
    ctx.save(); ctx.globalCompositeOperation = "destination-in"; ctx.globalAlpha = spec.opacity;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.restore();
  }
  ctx.save(); ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = PAPER; ctx.fillRect(0, 0, w, h); ctx.restore();
  const gradient = (horizontal: boolean, stops: [number, string][]) => {
    const g = ctx.createLinearGradient(0, 0, horizontal ? w : 0, horizontal ? 0 : h);
    stops.forEach(([at, color]) => g.addColorStop(at, color)); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  };
  // CSS paints the horizontal light underneath the vertical light.
  gradient(true, [[0, "rgba(0,0,0,.46)"], [.11, "rgba(0,0,0,.12)"], [.3, "rgba(255,255,255,.13)"], [.48, "rgba(255,255,255,.02)"], [.74, "rgba(0,0,0,.05)"], [1, "rgba(0,0,0,.40)"]]);
  gradient(false, [[0, "rgba(255,238,212,.22)"], [.09, "rgba(255,238,212,.05)"], [.26, "transparent"], [.8, "transparent"], [1, "rgba(0,0,0,.34)"]]);
  ctx.fillStyle = "rgba(255,248,236,.32)"; ctx.fillRect(0, 0, w, 1 / spec.scale);
  const pattern = ctx.createPattern(grain, "repeat");
  if (pattern) {
    pattern.setTransform(new DOMMatrix().scale(1 / spec.scale));
    ctx.globalAlpha = .055; ctx.fillStyle = pattern; ctx.fillRect(0, 0, w, h);
  }
  // Throws on a tainted canvas: the caller retains the DOM spine on tablet/provider routes without CORS.
  ctx.getImageData(0, 0, 1, 1);
  return { canvas, ratio };
}
