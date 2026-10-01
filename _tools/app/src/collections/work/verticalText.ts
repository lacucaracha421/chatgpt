// Upright vertical (tategaki) typesetting for spine titles. Punctuation and brackets take their
// vertical presentation forms; Latin words stay sideways (text-orientation: mixed) and one- or
// two-digit numbers stand upright as one cell (text-combine-upright).

const verticalForms: Record<string, string> = {
  ",": "︐", "，": "︐", "、": "︑", ".": "︒", "。": "︒", "．": "︒", ":": "︓", "：": "︓", ";": "︔", "；": "︔",
  "!": "︕", "！": "︕", "?": "︖", "？": "︖", "…": "︙", "‥": "︰",
  "(": "︵", "（": "︵", ")": "︶", "）": "︶", "[": "﹇", "［": "﹇", "]": "﹈", "］": "﹈", "{": "︷", "｛": "︷", "}": "︸", "｝": "︸",
  "「": "﹁", "」": "﹂", "『": "﹃", "』": "﹄", "‘": "﹁", "’": "﹂", "“": "﹃", "”": "﹄",
  "【": "︻", "】": "︼", "〔": "︹", "〕": "︺", "《": "︽", "》": "︾", "〈": "︿", "〉": "﹀", "<": "︿", ">": "﹀", "＜": "︿", "＞": "﹀",
  // U+301C is typeset vertically by the font (vert) or rotated by the browser (UTR #50 "Tr").
  "~": "〜", "～": "〜", "-": "︱", "‐": "︱", "–": "︱", "—": "︱", "―": "︱", "ー": "︱",
};
// Doubled marks read as one upright cell, as on printed spines.
const pairedMarks: Record<string, string> = { "!!": "‼", "！！": "‼", "!?": "⁉", "！？": "⁉", "?!": "⁈", "？！": "⁈", "??": "⁇", "？？": "⁇" };
const latin = /[A-Za-z0-9]/;

/** Map one title to its vertical presentation forms. Marks inside a Latin run ("JoJo's", "X-Men", "1.5") stay with the sideways run. */
export function verticalSpineText(text: string): string {
  const chars = Array.from(text);
  let single = false, double = false, out = "";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index], previous = chars[index - 1] ?? "", next = chars[index + 1] ?? "";
    const pair = pairedMarks[char + next];
    if (pair) { out += pair; index += 1; continue; }
    if (char === "." && next === "." && chars[index + 2] === ".") { out += "︙"; index += 2; continue; }
    if (latin.test(previous) && latin.test(next) && /['.,:\-‐!?&]/.test(char)) { out += char; continue; }
    if (char === "'") { out += single ? "﹂" : "﹁"; single = !single; continue; }
    if (char === "\"") { out += double ? "﹄" : "﹃"; double = !double; continue; }
    out += verticalForms[char] ?? char;
  }
  return out;
}

export type VerticalRun = { text: string; upright: boolean };
/** Split mapped text into runs; one- or two-digit numbers not touching Latin letters stand upright (tate-chu-yoko). */
export function verticalSpineRuns(text: string): VerticalRun[] {
  const runs: VerticalRun[] = [];
  let from = 0;
  for (const match of text.matchAll(/\d+/g)) {
    const start = match.index ?? 0, end = start + match[0].length;
    if (match[0].length > 2 || /[A-Za-z]/.test(text[start - 1] ?? "") || /[A-Za-z]/.test(text[end] ?? "")) continue;
    if (start > from) runs.push({ text: text.slice(from, start), upright: false });
    runs.push({ text: match[0], upright: true });
    from = end;
  }
  if (from < text.length) runs.push({ text: text.slice(from), upright: false });
  return runs;
}

export type SpineTitleSplit = { parts: [string, string]; natural: boolean };
/** Candidate two-column splits: subtitle separators first (the separator itself is dropped), then spaces, else the middle. */
export function spineTitleSplits(title: string): SpineTitleSplit[] {
  const text = title.trim();
  const splits: SpineTitleSplit[] = [];
  const seen = new Set<string>();
  const add = (first: string, second: string, natural: boolean) => {
    const parts: [string, string] = [first.trim(), second.trim()];
    const key = parts.join("\n");
    if (!parts[0] || !parts[1] || seen.has(key)) return;
    seen.add(key); splits.push({ parts, natural });
  };
  for (const match of text.matchAll(/\s*[:：]\s*|\s+[-–—―~〜～]\s+|\s+(?=[(（「『［\[])/g)) add(text.slice(0, match.index ?? 0), text.slice((match.index ?? 0) + match[0].length), true);
  for (const match of text.matchAll(/\s+/g)) add(text.slice(0, match.index ?? 0), text.slice((match.index ?? 0) + match[0].length), false);
  if (!splits.length) {
    const chars = Array.from(text);
    if (chars.length > 1) add(chars.slice(0, Math.ceil(chars.length / 2)).join(""), chars.slice(Math.ceil(chars.length / 2)).join(""), false);
  }
  return splits;
}

/** Type sizes as a share of the spine width (the big book's --bd). */
export const SPINE_TITLE_SCALE = { base: .66, singleMin: .48, twoMax: .42, twoMin: .3 };
export type SpineTitleFit = { scale: number; columns: string[]; clipped: boolean };

/**
 * Fit a spine title into `available` px of spine height. `length(text)` is the measured inline
 * length of the mapped text at the base size, `width` the spine width in px. Shrink first, then
 * two columns (right column first), and only then clip with a vertical ellipsis.
 */
export function fitSpineTitle(title: string, { available, width, length }: { available: number; width: number; length(text: string): number }): SpineTitleFit {
  const { base, singleMin, twoMax, twoMin } = SPINE_TITLE_SCALE;
  const full = length(title);
  if (!(full > 0) || !(available > 0)) return { scale: base, columns: [title], clipped: false };
  const single = Math.min(base, base * available / full);
  const splits = spineTitleSplits(title);
  if (single >= singleMin || !splits.length) return single >= singleMin ? { scale: single, columns: [title], clipped: false } : clip([title], length, available, width, singleMin);
  const sized = splits.map(split => ({ ...split, scale: Math.min(twoMax, base * available / Math.max(length(split.parts[0]), length(split.parts[1]), 1)) }));
  const best = sized.reduce((winner, split) => split.scale > winner.scale ? split : winner);
  const natural = sized.filter(split => split.natural && split.scale >= twoMin && split.scale >= best.scale * .85).sort((a, b) => b.scale - a.scale)[0];
  const chosen = natural ?? best;
  if (chosen.scale >= twoMin) return { scale: chosen.scale, columns: chosen.parts, clipped: false };
  return clip(best.parts, length, available, width, twoMin);
}

function clip(columns: string[], length: (text: string) => number, available: number, width: number, scale: number): SpineTitleFit {
  const { base } = SPINE_TITLE_SCALE;
  const ellipsis = scale * width;
  const cut = columns.map(column => {
    const shown = length(column) * scale / base;
    if (shown <= available) return column;
    const chars = Array.from(column);
    const keep = Math.max(1, Math.floor(chars.length * Math.max(0, available - ellipsis) / shown));
    return `${chars.slice(0, keep).join("").trimEnd()}︙`;
  });
  return { scale, columns: cut, clipped: true };
}
