export type Range = { start: number; end: number };

export type NoteSection = {
  level: number;
  title: string;
  headingRange: Range;
  bodyRange: Range;
  lineCount: number;
  key: string;
};

export type SplitSections = {
  preamble: Range;
  sections: NoteSection[];
};

type Line = { start: number; end: number; fullEnd: number; text: string; ending: string };

function linesOf(body: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let index = 0;
  while (index < body.length) {
    const character = body[index];
    if (character !== "\n" && character !== "\r") {
      index += 1;
      continue;
    }
    const ending = character === "\r" && body[index + 1] === "\n" ? "\r\n" : character;
    const end = index;
    const fullEnd = index + ending.length;
    lines.push({ start, end, fullEnd, text: body.slice(start, end), ending });
    start = fullEnd;
    index = fullEnd;
  }
  if (start < body.length || body.length === 0) lines.push({ start, end: body.length, fullEnd: body.length, text: body.slice(start), ending: "" });
  return lines;
}

export function fenceStart(text: string): { mark: "`" | "~"; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(text);
  if (!match) return null;
  if (match[1]![0] === "`" && text.slice(match[0].length).includes("`")) return null;
  return { mark: match[1]![0] as "`" | "~", length: match[1]!.length };
}

export function fenceEnd(text: string, fence: { mark: "`" | "~"; length: number }): boolean {
  const trimmed = text.trim();
  if (trimmed.length < fence.length) return false;
  if (!trimmed[0] || trimmed[0] !== fence.mark) return false;
  return new RegExp(`^${fence.mark}{${fence.length},}[ \\t]*$`).test(trimmed);
}

function headingOf(text: string): { level: number; title: string } | null {
  const match = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(text);
  if (!match) return null;
  let title = text.slice(match[0].length).trim();
  let end = title.length;
  while (end > 0 && title[end - 1] === "#") end -= 1;
  if (end === 0) title = "";
  else if (end < title.length && /[ \t]/.test(title[end - 1]!)) title = title.slice(0, end).trimEnd();
  return { level: match[1]!.length, title };
}

function lineCount(body: string): number {
  return body.split(/\r\n|\n|\r/).filter((line) => line.trim() !== "").length;
}

function sectionKey(title: string, occurrence: number): string {
  return JSON.stringify([title, occurrence]);
}

export function splitSections(body: string): SplitSections {
  const lines = linesOf(body);
  const headings: Array<{ line: Line; level: number; title: string }> = [];
  let fence: { mark: "`" | "~"; length: number } | null = null;
  for (const line of lines) {
    if (fence) {
      if (fenceEnd(line.text, fence)) fence = null;
      continue;
    }
    const nextFence = fenceStart(line.text);
    if (nextFence) {
      fence = nextFence;
      continue;
    }
    const heading = headingOf(line.text);
    if (heading) headings.push({ line, ...heading });
  }

  const occurrences = new Map<string, number>();
  const sections = headings.map(({ line, level, title }, index) => {
    const occurrence = occurrences.get(title) ?? 0;
    occurrences.set(title, occurrence + 1);
    const next = headings[index + 1]?.line.start ?? body.length;
    return {
      level,
      title,
      headingRange: { start: line.start, end: line.end },
      bodyRange: { start: line.fullEnd, end: next },
      lineCount: lineCount(body.slice(line.fullEnd, next)),
      key: sectionKey(title, occurrence),
    } satisfies NoteSection;
  });
  return { preamble: { start: 0, end: headings[0]?.line.start ?? body.length }, sections };
}

function currentSection(body: string, section: NoteSection): NoteSection | null {
  return splitSections(body).sections.find((candidate) => candidate.headingRange.start === section.headingRange.start) ?? null;
}

function trailingEnding(value: string): string {
  const match = /(\r\n|\n|\r)$/.exec(value);
  return match?.[1] ?? "\n";
}

export function replaceSectionBody(body: string, section: NoteSection, nextBody: string): string {
  const current = currentSection(body, section);
  if (!current) return body;
  let replacement = nextBody;
  const hasNextHeading = current.bodyRange.end < body.length;
  if (hasNextHeading && replacement.length > 0 && !/(\r\n|\n|\r)$/.test(replacement)) {
    replacement += trailingEnding(body.slice(current.bodyRange.start, current.bodyRange.end));
  }
  return body.slice(0, current.bodyRange.start) + replacement + body.slice(current.bodyRange.end);
}

export function renameSection(body: string, section: NoteSection, title: string): string {
  const current = currentSection(body, section);
  if (!current) return body;
  const heading = body.slice(current.headingRange.start, current.headingRange.end);
  const prefix = /^( {0,3})(#{1,6})/.exec(heading);
  if (!prefix) return body;
  const cleanTitle = title.replace(/[\r\n]+/g, " ").trim();
  const line = `${prefix[1]}${prefix[2]}${cleanTitle ? ` ${cleanTitle}` : ""}`;
  return body.slice(0, current.headingRange.start) + line + body.slice(current.headingRange.end);
}

function sectionEnd(sections: NoteSection[], index: number): number {
  return sections[index]!.bodyRange.end;
}

export function moveSection(body: string, section: NoteSection, direction: "up" | "down"): string {
  const parsed = splitSections(body);
  const index = parsed.sections.findIndex((candidate) => candidate.headingRange.start === section.headingRange.start);
  if (index < 0) return body;
  const current = parsed.sections[index]!;
  if (direction === "up") {
    let target = index - 1;
    while (target >= 0 && parsed.sections[target]!.level > current.level) target -= 1;
    if (target < 0) return body;
    const previous = parsed.sections[target]!;
    const currentText = body.slice(current.headingRange.start, sectionEnd(parsed.sections, index));
    const before = body.slice(0, previous.headingRange.start);
    const between = body.slice(sectionEnd(parsed.sections, target), current.headingRange.start);
    const previousText = body.slice(previous.headingRange.start, sectionEnd(parsed.sections, target));
    const after = body.slice(sectionEnd(parsed.sections, index));
    return before + currentText + between + previousText + after;
  }
  let target = index + 1;
  while (target < parsed.sections.length && parsed.sections[target]!.level > current.level) target += 1;
  if (target >= parsed.sections.length) return body;
  const next = parsed.sections[target]!;
  const currentText = body.slice(current.headingRange.start, sectionEnd(parsed.sections, index));
  const between = body.slice(sectionEnd(parsed.sections, index), next.headingRange.start);
  const nextText = body.slice(next.headingRange.start, sectionEnd(parsed.sections, target));
  const before = body.slice(0, current.headingRange.start);
  const after = body.slice(sectionEnd(parsed.sections, target));
  return before + between + nextText + currentText + after;
}

export function unfixSection(body: string, section: NoteSection): string {
  const current = currentSection(body, section);
  if (!current) return body;
  return body.slice(0, current.headingRange.start) + current.title + body.slice(current.headingRange.end);
}

export function deleteSection(body: string, section: NoteSection): string {
  const current = currentSection(body, section);
  if (!current) return body;
  return body.slice(0, current.headingRange.start) + body.slice(current.bodyRange.end);
}

export function appendSection(body: string, title = "새 제목"): string {
  const cleanTitle = title.replace(/[\r\n]+/g, " ").trim() || "새 제목";
  const separator = body.length === 0 || /(\r\n|\n|\r)$/.test(body) ? "" : "\n";
  return `${body}${separator}## ${cleanTitle}\n`;
}
