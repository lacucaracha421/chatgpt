import type { ImageTextLine } from "../../library/types";

export type ImageRect = { left: number; top: number; width: number; height: number };
export type ImageZoom = { scale: number; x: number; y: number };
export type NoteBox = { x: number; y: number; w: number; h: number };
export type NoteFrame = { W: number; H: number };
export type NoteMeasure = (font: number, rect: { w: number }, padX: number, padY: number, wrap: boolean) => { overflow: number; height: number };
export type NoteFit = NoteBox & { index: number; f: number; padX: number; padY: number; wrap: boolean; widened: boolean; grown: number; variants?: NoteFit[]; stacked?: boolean; zIndex?: number };
export const MIN_FONT = 14;
const EDGE = 4;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

// Ported from the collector's pure note layout. Coordinates are displayed image pixels.
export function fitNote({ box, W, H, vertical = false, chars = 1, measure, minF = MIN_FONT }: { box: NoteBox; W: number; H: number; vertical?: boolean; chars?: number; measure: NoteMeasure; minF?: number }): NoteFit {
  const padY = clamp(Math.round(Math.min(box.w, box.h) * .1), 3, 8), padX = vertical ? Math.max(2, padY - 2) : padY;
  const start = Math.round(clamp(Math.sqrt(box.w * box.h / Math.max(1, chars)) * .8, minF, 20) * 2) / 2;
  const r = { x: box.x - 3, y: box.y - 3, w: box.w + 6, h: box.h + 6 };
  const right = Math.min(W - EDGE, r.x + r.w), bottom = Math.min(H - EDGE, r.y + r.h);
  r.x = Math.max(EDGE, r.x); r.y = Math.max(EDGE, r.y); r.w = Math.max(1, right - r.x); r.h = Math.max(1, bottom - r.y);
  const base = { ...r }, step = (value: number) => Math.round((value - .5) * 2) / 2;
  let wrap = false, widened = false, f = start, done = false;
  const probe = (size: number) => measure(size, r, padX, padY, wrap);
  const fits = (size: number) => { const m = probe(size); return m.overflow <= .5 && m.height <= r.h - 2 * padY + .5; };
  for (let size = start; size >= minF; size = step(size)) { f = size; if (fits(size)) { done = true; break; } }
  if (!done) f = minF;
  if (!done) {
    const overflow = probe(f).overflow;
    if (overflow > .5) {
      // The longest word is wider than the note: widen just enough for it, centred on the box.
      const w = Math.min(W - 2 * EDGE, r.w + Math.ceil(overflow) + 1), cx = r.x + r.w / 2;
      r.x = clamp(cx - w / 2, EDGE, Math.max(EDGE, W - EDGE - w)); r.w = w; widened = true;
      for (let size = start; size > minF; size = step(size)) if (fits(size)) { f = size; done = true; break; }
      if (!done) { f = minF; done = fits(f); }
    }
  }
  const grow = () => {
    const next = Math.min(H - EDGE, r.y + r.h + 6);
    if (next > r.y + r.h) { r.h = next - r.y; return true; }
    const top = Math.max(EDGE, r.y - 6);
    if (top === r.y) return false;
    r.h += r.y - top; r.y = top; return true;
  };
  while (!done && grow()) if (fits(f)) done = true;
  // Last resort: a single word wider than the whole image may break.
  if (!done) { wrap = true; while (grow()) if (fits(f)) break; }
  return { index: -1, x: r.x, y: r.y, w: r.w, h: r.h, f, padX, padY, wrap, widened, grown: Math.round(r.h - base.h) };
}
// All variants use premeasured whole words. Never trade legibility for separation.
export function noteVariants(fit: NoteFit, { W, H }: NoteFrame, measure: NoteMeasure): NoteFit[] {
  if (fit.wrap) return [];
  const variants = [];
  for (const f of [...new Set([fit.f, MIN_FONT])]) {
    for (const reduction of [0, 2]) {
      const padX = Math.max(2, fit.padX - reduction), padY = Math.max(2, fit.padY - reduction);
      const minWidth = Math.ceil(measure(f, { w: 2 * padX }, padX, padY, false).overflow + 2 * padX + 1);
      for (const w of [...new Set([fit.w, Math.max(minWidth, fit.w * .9), Math.max(minWidth, fit.w * .8), minWidth])]) {
        if (w > fit.w || w > W - 2 * EDGE) continue;
        const m = measure(f, { w }, padX, padY, false);
        const h = Math.max(fit.h - 2 * reduction, Math.ceil(m.height + 2 * padY));
        if (m.overflow > .5 || h > H - 2 * EDGE) continue;
        variants.push({ ...fit, w, h, f, padX, padY, wrap: false,
          y: Math.min(fit.y, H - EDGE - h) });
      }
    }
  }
  return variants;
}
// Pure, bounded coordinate descent. Gap area wins first, then total distance from
// the fitted OCR anchors, then shape changes; vertical moves win equal ties.
// `variants` must have been validated with noteVariants before entering this pass.
export function resolveOverlaps(rects: NoteFit[], { W, H }: NoteFrame): NoteFit[] {
  const result = rects.map(r => ({ ...r }));
  const area = (a: NoteBox, b: NoteBox) => Math.max(0, Math.min(a.x + a.w + EDGE, b.x + b.w + EDGE) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h + EDGE, b.y + b.h + EDGE) - Math.max(a.y, b.y));
  const distance = (r: NoteBox, anchor: NoteBox) => Math.hypot(r.x - anchor.x, r.y - anchor.y);
  const better = (a: number[], b: number[]) => {
    for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > .001) return a[k] < b[k];
    return false;
  };
  for (let round = -1; round < 6; round++) {
    let changed = false;
    for (let i = 0; i < result.length; i++) {
      const anchor = rects[i], current = result[i];
      if (!result.some((r, j) => j !== i && area(current, r) > 0)) continue;
      const cap = Math.max(48, .4 * Math.max(anchor.w, anchor.h));
      const score = (r: NoteFit, limit = Infinity) => {
        let overlap = 0;
        for (let j = 0; j < result.length; j++) if (i !== j) {
          overlap += area(r, result[j]);
          if (overlap > limit + .001) return [overlap];
        }
        return [overlap, distance(r, anchor), Math.abs(r.w - anchor.w) + Math.abs(r.h - anchor.h) + Math.abs((r.f || 14) - (anchor.f || 14)), Math.abs(r.x - anchor.x)];
      };
      let best = current, bestScore = score(current);
      const shapes = [...new Map([anchor, ...(anchor.variants || [])].map(r => [[r.w, r.h, r.f, r.padX, r.padY].join('/'), r])).values()];
      const ranked = shapes.map(shape => ({ shape, score: score(shape) })).sort((a, b) => better(a.score, b.score) ? -1 : better(b.score, a.score) ? 1 : 0);
      // Try shrinking at the anchor before movement, and bound the movement search
      // to the three most promising shapes even in very dense OCR results.
      for (const entry of ranked) if (distance(entry.shape, anchor) <= cap && better(entry.score, bestScore)) { best = entry.shape; bestScore = entry.score; }
      // Give every neighbour its chance to shrink before displacing any anchor.
      if (round === -1) {
        if (best !== current) { result[i] = { ...best }; changed = true; }
        continue;
      }
      if (bestScore[0] === 0 && bestScore[1] === 0) { result[i] = { ...best }; changed = true; continue; }
      const blockers = result.filter((other, j) => j !== i && area(current, other) > 0)
        .sort((a, b) => distance(a, current) - distance(b, current)).slice(0, 4);
      for (const shape of [...new Set([anchor, current, ...ranked.slice(0, 3).map(entry => entry.shape)])]) {
        const xs = [current.x, anchor.x], ys = [current.y, shape.y];
        for (const other of blockers) {
          xs.push(other.x - shape.w - EDGE, other.x + other.w + EDGE);
          ys.push(other.y - shape.h - EDGE, other.y + other.h + EDGE);
        }
        const positions = [...new Set(ys)].map(y => [current.x, y]).concat([...new Set(xs)].map(x => [x, current.y]));
        for (const [x0, y0] of positions) {
          let x = clamp(x0, EDGE, Math.max(EDGE, W - EDGE - shape.w));
          let y = clamp(y0, EDGE, Math.max(EDGE, H - EDGE - shape.h));
          const d = Math.hypot(x - anchor.x, y - anchor.y);
          if (d > cap) { x = anchor.x + (x - anchor.x) * cap / d; y = anchor.y + (y - anchor.y) * cap / d; }
          if (x < EDGE || y < EDGE || x + shape.w > W - EDGE || y + shape.h > H - EDGE) continue;
          const candidate = { ...shape, x, y }, candidateScore = score(candidate, bestScore[0]);
          if (better(candidateScore, bestScore)) { best = candidate; bestScore = candidateScore; }
        }
      }
      if (best !== current) { result[i] = best; changed = true; }
    }
    if (!changed && round >= 0) break;
  }
  const stacked = result.map((r, i) => result.some((other, j) => i !== j && area(r, other) > 0));
  const order = result.map((_, i) => i).filter(i => stacked[i]).sort((a, b) =>
    result[b].w * result[b].h - result[a].w * result[a].h || result[b].y - result[a].y || b - a);
  order.forEach((i, rank) => { result[i].stacked = true; result[i].zIndex = rank + 2; });
  return result;
}

/** Whole-word wrapping; only an image-wide word may use the last-resort character wrap. */
export function textMeasure(text: string, widthOf: (text: string, font: number) => number): NoteMeasure {
  const paragraphs = text.split(/\r?\n/).map(part => part.trim().split(/\s+/).filter(Boolean));
  return (font, rect, padX, _padY, wrap) => {
    const available = Math.max(1, rect.w - 2 * padX);
    let count = 0, longest = 0;
    for (const words of paragraphs) {
      let used = 0; count++;
      for (const word of words) {
        const width = widthOf(word, font); longest = Math.max(longest, width);
        const space = used ? widthOf(" ", font) : 0;
        if (used && used + space + width > available) { count++; used = 0; }
        if (wrap && width > available) { count += Math.ceil(width / available) - 1; used = width % available; }
        else used += (used ? space : 0) + width;
      }
    }
    return { overflow: wrap ? 0 : Math.max(0, longest - available), height: count * font * 1.28 };
  };
}

export function lineGeometry(line: ImageTextLine, W: number, H: number) {
  const b = line.box;
  if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) return null;
  const x = clamp(b.x0 / 1000 * W, 0, W), y = clamp(b.y0 / 1000 * H, 0, H);
  const w = clamp(b.x1 / 1000 * W, 0, W) - x, h = clamp(b.y1 / 1000 * H, 0, H) - y;
  if (w <= 0 || h <= 0) return null;
  return { box: { x, y, w, h }, vertical: h > w * 1.4 && /[぀-ヿ㐀-鿿]/.test(line.original), chars: (line.original || line.korean).replace(/[\s、。，．,.!！?？…ー〜~]/g, "").length };
}

export function layoutImageTextNotes(lines: ImageTextLine[], W: number, H: number, widthOf: (text: string, font: number) => number): NoteFit[] {
  if (W <= 8 || H <= 8) return [];
  const notes: NoteFit[] = [];
  lines.forEach((line, index) => {
    const geometry = lineGeometry(line, W, H);
    if (!geometry || !line.korean.trim()) return;
    const measure = textMeasure(line.korean, widthOf);
    const fit = { ...fitNote({ ...geometry, W, H, measure }), index };
    notes.push({ ...fit, variants: noteVariants(fit, { W, H }, measure) });
  });
  return resolveOverlaps(notes, { W, H });
}
