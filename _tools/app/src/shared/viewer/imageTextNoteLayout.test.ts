import { expect, it } from "vitest";
import { fitNote, layoutImageTextNotes, noteVariants, resolveOverlaps, textMeasure } from "./imageTextNoteLayout";
import type { ImageTextLine } from "../../library/types";

const widthOf = (text: string, font: number) => [...text].length * font;
const line = (korean: string, box = { x0: 100, y0: 100, x1: 300, y1: 300 }): ImageTextLine => ({ original: "原文", korean, box });

it("keeps at least 14 screen pixels even in tiny OCR boxes", () => {
  const [note] = layoutImageTextNotes([line("번역 문장", { x0: 100, y0: 100, x1: 110, y1: 110 })], 500, 700, widthOf);
  expect(note.f).toBeGreaterThanOrEqual(14);
  expect(note.h).toBeGreaterThan(7);
});

it("wraps whole words and widens only for the longest word before growing down", () => {
  const measure = textMeasure("가나다라마 짧게 짧게 짧게", widthOf);
  const note = fitNote({ box: { x: 100, y: 100, w: 20, h: 20 }, W: 500, H: 700, measure });
  expect(note.f).toBe(14);
  expect(note.wrap).toBe(false);
  expect(note.w).toBeLessThanOrEqual(5 * 14 + note.padX * 2 + 2);
  expect(note.y).toBe(97);
  expect(note.grown).toBeGreaterThan(0);
  expect(measure(14, note, note.padX, note.padY, false).overflow).toBe(0);
  expect(textMeasure("가나다 라마바", widthOf)(14, { w: 50 }, 3, 3, false).height).toBeCloseTo(2 * 14 * 1.28);
});

it("grows upward at the bottom edge without crossing the image", () => {
  const note = fitNote({ box: { x: 50, y: 180, w: 60, h: 16 }, W: 300, H: 200, measure: textMeasure("길게 번역한 여러 단어가 있는 문장", widthOf) });
  expect(note.y).toBeLessThan(177);
  expect(note.y + note.h).toBeLessThanOrEqual(196);
  expect(note.f).toBe(14);
  expect(note.wrap).toBe(false);
});

it("skips unpositioned and invalid boxes, preserving original indices", () => {
  const notes = layoutImageTextNotes([{ original: "no", korean: "없음" }, line("표시"), line("잘못", { x0: 400, y0: 400, x1: 300, y1: 300 })], 500, 700, widthOf);
  expect(notes.map(note => note.index)).toEqual([1]);
  expect(layoutImageTextNotes([line("표시")], 0, 0, widthOf)).toEqual([]);
});

it("separates nearby notes with a 4px gap inside the image and caps movement", () => {
  const notes = layoutImageTextNotes([line("하나"), line("둘")], 500, 700, widthOf);
  const [a, b] = notes;
  expect(a.x + a.w + 4 <= b.x || b.x + b.w + 4 <= a.x || a.y + a.h + 4 <= b.y || b.y + b.h + 4 <= a.y).toBe(true);
  for (const note of notes) {
    expect(note.x).toBeGreaterThanOrEqual(4);
    expect(note.y).toBeGreaterThanOrEqual(4);
    expect(note.x + note.w).toBeLessThanOrEqual(496);
    expect(note.y + note.h).toBeLessThanOrEqual(696);
    expect(Math.hypot(note.x - 47, note.y - 67)).toBeLessThanOrEqual(Math.max(48, .4 * 146) + .01);
  }
});

it("tries narrower shapes before moves and stacks the smallest unresolved note on top", () => {
  const measure = textMeasure("짧은 말", widthOf);
  const fit = fitNote({ box: { x: 4, y: 4, w: 80, h: 80 }, W: 100, H: 100, measure });
  const variants = noteVariants(fit, { W: 100, H: 100 }, measure);
  expect(variants.some(note => note.w < fit.w)).toBe(true);
  const [large, small] = resolveOverlaps([{ ...fit, index: 0 }, { ...fit, index: 1, w: fit.w - 5 }], { W: 100, H: 100 });
  expect(large.stacked).toBe(true);
  expect(small.zIndex).toBeGreaterThan(large.zIndex!);
});
