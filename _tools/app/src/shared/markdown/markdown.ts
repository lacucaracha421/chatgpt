/**
 * Small in-house Markdown parser for Notes (ADR-0035 amendment, 2026-09-24).
 *
 * It produces a plain AST that `MarkdownView` turns into React elements; no HTML string is
 * ever built, so raw HTML in a note is only text. Supported: ATX headings (#..###),
 * paragraphs (a single newline is a line break), **bold**, *italic*, `code`, fenced code,
 * blockquotes, `-`/`*`/`1.` lists with one nesting level, task items, http(s) links and
 * bare http(s) autolinks, horizontal rules and backslash escapes. Images, tables and raw
 * HTML are not supported and stay literal text.
 *
 * Shared by the PC app and the Android web client (`mobile-client` imports it via `../src`).
 * Every scan is linear or bounded so adversarial input (long lines, deep markers, unclosed
 * delimiters) cannot stall the UI.
 */

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: MarkdownInline[] }
  | { type: "break" };

export type MarkdownListItem = {
  /** Source line index (0-based, split on `\n`) of the item's marker line. */
  line: number;
  /** Present for `- [ ]` / `- [x]` items. */
  checked?: boolean;
  children: MarkdownInline[];
  /** At most one nesting level; nested items never have their own sublists. */
  sublists: MarkdownList[];
};

export type MarkdownList = { type: "list"; ordered: boolean; start: number; items: MarkdownListItem[] };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; children: MarkdownInline[] }
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "codeBlock"; text: string }
  | { type: "blockquote"; children: MarkdownBlock[] }
  | MarkdownList
  | { type: "hr" };

type Line = { text: string; index: number };

/** Nested `>` beyond this depth is shown as literal text. */
const MAX_QUOTE_DEPTH = 4;
const ESCAPABLE = new Set("\\`*_{}[]()#+-.!>|~<\"'&:".split(""));

/** Returns the normalized URL when it is an absolute http(s) URL, otherwise null. */
export function safeHttpUrl(raw: string): string | null {
  const value = raw.trim();
  // Only a literal, unobfuscated scheme is accepted: entities are never decoded and any
  // whitespace or control character anywhere rejects the URL outright.
  if (!/^https?:\/\//i.test(value)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f-\u009f<>"`\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  return url.href;
}

export function splitMarkdownLines(source: string): string[] {
  return source.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = splitMarkdownLines(source).map((text, index) => ({ text, index }));
  return parseBlocks(lines, 0);
}

/**
 * Rewrites the task marker on `lineIndex` (as reported by `MarkdownListItem.line`).
 * Returns the source unchanged when that line is not a task item.
 */
export function toggleMarkdownTask(source: string, lineIndex: number, checked: boolean): string {
  const lines = source.split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return source;
  const match = /^((?:[ \t]{0,3}>[ \t]?){0,4}[ \t]*(?:[-*]|\d{1,9}[.)])[ \t]+\[)[ xX](\])/.exec(line);
  if (!match) return source;
  lines[lineIndex] = match[1] + (checked ? "x" : " ") + line.slice(match[1].length + 1);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Blocks

/** Leading indentation width; a tab counts as four columns. */
function indentOf(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " ") width++;
    else if (text[i] === "\t") width += 4;
    else break;
  }
  return width;
}

function isBlank(text: string) {
  return text.trim() === "";
}

function isHr(text: string): boolean {
  if (indentOf(text) > 3) return false;
  const compact = text.replace(/[ \t]/g, "");
  if (compact.length < 3) return false;
  const mark = compact[0];
  if (mark !== "-" && mark !== "*" && mark !== "_") return false;
  for (let i = 1; i < compact.length; i++) if (compact[i] !== mark) return false;
  return true;
}

function headingOf(text: string): { level: 1 | 2 | 3; content: string } | null {
  const match = /^ {0,3}(#{1,3})(?=[ \t]|$)/.exec(text);
  if (!match) return null;
  let content = text.slice(match[0].length).trim();
  // Optional closing sequence: "## Title ##".
  let end = content.length;
  while (end > 0 && content[end - 1] === "#") end--;
  if (end === 0) content = "";
  else if (end < content.length && (content[end - 1] === " " || content[end - 1] === "\t")) content = content.slice(0, end).trimEnd();
  return { level: match[1].length as 1 | 2 | 3, content };
}

function fenceOf(text: string): { mark: string; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(text);
  if (!match) return null;
  // A backtick fence's info string cannot contain backticks.
  if (match[1][0] === "`" && text.slice(match[0].length).includes("`")) return null;
  return { mark: match[1][0], length: match[1].length };
}

function isFenceClose(text: string, fence: { mark: string; length: number }): boolean {
  if (indentOf(text) > 3) return false;
  const trimmed = text.trim();
  if (trimmed.length < fence.length) return false;
  for (let i = 0; i < trimmed.length; i++) if (trimmed[i] !== fence.mark) return false;
  return true;
}

function quoteContent(text: string): string | null {
  const match = /^ {0,3}>[ ]?/.exec(text);
  return match ? text.slice(match[0].length) : null;
}

type ListMarker = { indent: number; ordered: boolean; start: number; content: string };

function listMarkerOf(text: string): ListMarker | null {
  const match = /^([ \t]*)([-*]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(text);
  if (!match) return null;
  const ordered = match[2] !== "-" && match[2] !== "*";
  return { indent: indentOf(match[1]), ordered, start: ordered ? Number.parseInt(match[2], 10) : 1, content: text.slice(match[0].length) };
}

function startsBlock(text: string, quoteDepth: number): boolean {
  return (
    isHr(text) ||
    headingOf(text) !== null ||
    fenceOf(text) !== null ||
    (quoteDepth < MAX_QUOTE_DEPTH && quoteContent(text) !== null) ||
    listMarkerOf(text) !== null
  );
}

function parseBlocks(lines: Line[], quoteDepth: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const { text } = lines[i];
    if (isBlank(text)) {
      i++;
      continue;
    }
    const fence = fenceOf(text);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i].text, fence)) body.push(lines[i++].text);
      i++; // closing fence (or past the end when unclosed)
      blocks.push({ type: "codeBlock", text: body.join("\n") });
      continue;
    }
    const heading = headingOf(text);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, children: parseInline(heading.content) });
      i++;
      continue;
    }
    if (isHr(text)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (quoteDepth < MAX_QUOTE_DEPTH && quoteContent(text) !== null) {
      const inner: Line[] = [];
      while (i < lines.length) {
        const content = quoteContent(lines[i].text);
        if (content === null) break;
        inner.push({ text: content, index: lines[i].index });
        i++;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(inner, quoteDepth + 1) });
      continue;
    }
    if (listMarkerOf(text)) {
      i = parseList(lines, i, blocks);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && !isBlank(lines[i].text) && (paragraph.length === 0 || !startsBlock(lines[i].text, quoteDepth))) {
      paragraph.push(lines[i].text.trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: joinLines(paragraph) });
  }
  return blocks;
}

function joinLines(lines: string[]): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ type: "break" });
    out.push(...parseInline(line));
  });
  return out;
}

function listItem(marker: ListMarker, line: number): MarkdownListItem {
  const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(marker.content);
  const content = task ? marker.content.slice(task[0].length) : marker.content;
  return {
    line,
    ...(task ? { checked: task[1] !== " " } : {}),
    children: parseInline(content.trim()),
    sublists: [],
  };
}

/** Parses a list starting at `start`; returns the index after it. Indent ≥2 nests one level. */
function parseList(lines: Line[], start: number, blocks: MarkdownBlock[]): number {
  const first = listMarkerOf(lines[start].text)!;
  const list: MarkdownList = { type: "list", ordered: first.ordered, start: first.start, items: [] };
  const topIndent = first.indent;
  let i = start;
  while (i < lines.length) {
    const { text, index } = lines[i];
    if (isBlank(text)) {
      // A blank line continues the list only when another item follows.
      let next = i + 1;
      while (next < lines.length && isBlank(lines[next].text)) next++;
      if (next < lines.length && listMarkerOf(lines[next].text) && !isHr(lines[next].text)) {
        i = next;
        continue;
      }
      break;
    }
    if (isHr(text)) break;
    const marker = listMarkerOf(text);
    const parent = list.items[list.items.length - 1];
    if (marker) {
      if (marker.indent >= topIndent + 2 && parent) {
        const sub = parent.sublists[parent.sublists.length - 1];
        if (sub && sub.ordered === marker.ordered) sub.items.push(listItem(marker, index));
        else parent.sublists.push({ type: "list", ordered: marker.ordered, start: marker.start, items: [listItem(marker, index)] });
      } else {
        if (marker.ordered !== list.ordered) break;
        list.items.push(listItem(marker, index));
      }
      i++;
      continue;
    }
    // An indented plain line continues the previous item's text.
    if (parent && indentOf(text) >= topIndent + 2 && !startsBlock(text, MAX_QUOTE_DEPTH)) {
      const sub = parent.sublists[parent.sublists.length - 1];
      const target = sub ? sub.items[sub.items.length - 1] : parent;
      target.children.push({ type: "break" }, ...parseInline(text.trim()));
      i++;
      continue;
    }
    break;
  }
  blocks.push(list);
  return i;
}

// ---------------------------------------------------------------------------------------
// Inlines

type Token =
  | { kind: "node"; node: MarkdownInline }
  | { kind: "delim"; length: 1 | 2; canOpen: boolean; canClose: boolean; match: number; opener: boolean };

function isSpace(char: string | undefined) {
  return char === undefined || /\s/.test(char);
}

function isWordChar(char: string | undefined) {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

/** Precomputes, for every position, the index of the next occurrence of `char` (or -1). */
function nextIndexTable(text: string, char: string): Int32Array {
  const table = new Int32Array(text.length + 1).fill(-1);
  for (let i = text.length - 1; i >= 0; i--) table[i] = text[i] === char ? i : table[i + 1];
  return table;
}

type InlineContext = {
  text: string;
  nextBracket: Int32Array;
  nextParen: Int32Array;
  /** Backtick runs by length, each an ascending list of start positions, plus a cursor. */
  ticks: Map<number, { starts: number[]; cursor: number }>;
};

function inlineContext(text: string): InlineContext {
  const ticks = new Map<number, { starts: number[]; cursor: number }>();
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`" || (i > 0 && text[i - 1] === "\\")) {
      i++;
      continue;
    }
    let end = i;
    while (end < text.length && text[end] === "`") end++;
    const length = end - i;
    const bucket = ticks.get(length) ?? { starts: [], cursor: 0 };
    bucket.starts.push(i);
    ticks.set(length, bucket);
    i = end;
  }
  return { text, nextBracket: nextIndexTable(text, "]"), nextParen: nextIndexTable(text, ")"), ticks };
}

export function parseInline(text: string): MarkdownInline[] {
  return parseInlineIn(inlineContext(text), 0, text.length, true);
}

/** Finds the closing backtick run for an opening run of `length` at `start`; linear overall. */
function closingTicks(context: InlineContext, start: number, length: number, end: number): number {
  const bucket = context.ticks.get(length);
  if (!bucket) return -1;
  while (bucket.cursor < bucket.starts.length && bucket.starts[bucket.cursor] <= start) bucket.cursor++;
  const close = bucket.starts[bucket.cursor];
  return close !== undefined && close + length <= end ? close : -1;
}

/** `[label](url)` starting at `open` (the `[`); returns the parts or null. */
function linkAt(context: InlineContext, open: number, end: number) {
  const close = context.nextBracket[open + 1];
  if (close < 0 || close + 1 >= end || context.text[close + 1] !== "(") return null;
  const paren = context.nextParen[close + 2];
  if (paren < 0 || paren >= end) return null;
  const url = context.text.slice(close + 2, paren).trim();
  if (/\s/.test(url)) return null;
  return { labelStart: open + 1, labelEnd: close, url, end: paren + 1 };
}

const TRAILING_URL_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", '"', ")", "]", "*", "_"]);

/**
 * A bare http(s) URL at `start`. A candidate that fails validation is still returned (with
 * `href: null`) so the caller skips it as text; rescanning it from every later "h" would be
 * quadratic on long hostile lines.
 */
function autolinkAt(text: string, start: number, end: number): { href: string | null; end: number } | null {
  const head = text.slice(start, start + 8).toLowerCase();
  if (!head.startsWith("http://") && !head.startsWith("https://")) return null;
  if (isWordChar(text[start - 1])) return null;
  let stop = start;
  while (stop < end && !/[\s<>"`\\\u0000-\u001f\u007f-\u009f]/.test(text[stop])) stop++;
  // Drop trailing punctuation; keep a closing paren only when it balances one in the URL.
  let opens = 0;
  let closes = 0;
  for (let i = start; i < stop; i++) {
    if (text[i] === "(") opens++;
    else if (text[i] === ")") closes++;
  }
  while (stop > start && TRAILING_URL_PUNCTUATION.has(text[stop - 1])) {
    if (text[stop - 1] === ")") {
      if (opens >= closes) break;
      closes--;
    }
    stop--;
  }
  return { href: safeHttpUrl(text.slice(start, stop)), end: Math.max(stop, start + 1) };
}

function parseInlineIn(context: InlineContext, from: number, end: number, allowLinks: boolean): MarkdownInline[] {
  const { text } = context;
  const tokens: Token[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) tokens.push({ kind: "node", node: { type: "text", text: buffer } });
    buffer = "";
  };
  let i = from;
  while (i < end) {
    const char = text[i];
    if (char === "\\" && i + 1 < end && ESCAPABLE.has(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (char === "`") {
      let run = i;
      while (run < end && text[run] === "`") run++;
      const length = run - i;
      const close = closingTicks(context, i, length, end);
      if (close >= 0) {
        flush();
        let code = text.slice(run, close);
        if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        tokens.push({ kind: "node", node: { type: "code", text: code } });
        i = close + length;
      } else {
        buffer += text.slice(i, run);
        i = run;
      }
      continue;
    }
    if (char === "!" && text[i + 1] === "[" && i + 1 < end) {
      const image = linkAt(context, i + 1, end);
      if (image) {
        // Images are not supported: the whole construct stays literal text.
        buffer += text.slice(i, image.end);
        i = image.end;
        continue;
      }
    }
    if (char === "[" && allowLinks) {
      const link = linkAt(context, i, end);
      if (link) {
        const href = safeHttpUrl(link.url);
        if (href) {
          flush();
          tokens.push({ kind: "node", node: { type: "link", href, children: parseInlineIn(context, link.labelStart, link.labelEnd, false) } });
        } else {
          buffer += text.slice(i, link.end);
        }
        i = link.end;
        continue;
      }
    }
    if (allowLinks && (char === "h" || char === "H")) {
      const auto = autolinkAt(text, i, end);
      if (auto && !auto.href) {
        buffer += text.slice(i, auto.end);
        i = auto.end;
        continue;
      }
      if (auto?.href) {
        flush();
        tokens.push({ kind: "node", node: { type: "link", href: auto.href, children: [{ type: "text", text: text.slice(i, auto.end) }] } });
        i = auto.end;
        continue;
      }
    }
    if (char === "*") {
      let run = i;
      while (run < end && text[run] === "*") run++;
      const length = run - i;
      if (length <= 2) {
        flush();
        const before = i > from ? text[i - 1] : undefined;
        const after = run < end ? text[run] : undefined;
        tokens.push({ kind: "delim", length: length as 1 | 2, canOpen: !isSpace(after), canClose: !isSpace(before), match: -1, opener: false });
      } else {
        buffer += text.slice(i, run);
      }
      i = run;
      continue;
    }
    buffer += char;
    i++;
  }
  flush();
  matchDelimiters(tokens);
  return buildTree(tokens);
}

/** Pairs `*`/`**` runs with a stack; amortized linear because unmatched openers are dropped. */
function matchDelimiters(tokens: Token[]) {
  const stack: number[] = [];
  const open = { 1: 0, 2: 0 };
  tokens.forEach((token, index) => {
    if (token.kind !== "delim") return;
    if (token.canClose && open[token.length] > 0) {
      while (stack.length > 0) {
        const top = stack.pop()!;
        const opener = tokens[top] as Extract<Token, { kind: "delim" }>;
        open[opener.length]--;
        if (opener.length === token.length) {
          opener.match = index;
          opener.opener = true;
          token.match = top;
          return;
        }
      }
    }
    if (token.canOpen) {
      stack.push(index);
      open[token.length]++;
    }
  });
}

function buildTree(tokens: Token[]): MarkdownInline[] {
  type Frame = { length: 1 | 2; children: MarkdownInline[] };
  const root: MarkdownInline[] = [];
  const frames: Frame[] = [];
  const push = (node: MarkdownInline) => {
    const target = frames.length ? frames[frames.length - 1].children : root;
    const last = target[target.length - 1];
    if (node.type === "text" && last?.type === "text") last.text += node.text;
    else target.push(node);
  };
  for (const token of tokens) {
    if (token.kind === "node") push(token.node);
    else if (token.match < 0) push({ type: "text", text: "*".repeat(token.length) });
    else if (token.opener) frames.push({ length: token.length, children: [] });
    else {
      const frame = frames.pop()!;
      push(frame.length === 2 ? { type: "strong", children: frame.children } : { type: "em", children: frame.children });
    }
  }
  return root;
}
