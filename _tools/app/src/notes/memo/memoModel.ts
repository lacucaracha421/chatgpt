import { deleteSection, fenceEnd, fenceStart, renameSection, splitSections, type NoteSection } from '../sections';

export type MemoMode = 'text' | 'todo';
export type MemoLine = { id: string; raw: string; ending: string };
export type MemoDocument = { lines: MemoLine[]; nextId: number };
export type MemoItem = MemoLine & { text: string; task: boolean; done: boolean; sectionId: string; fenced: boolean };
export type MemoSection = { id: string; title: string | null; heading: NoteSection | null; items: MemoItem[] };
export const TOP_SECTION = 'top';
const taskPattern = /^(\s*[-*+]\s+\[)([ xX])(\])([ \t]*)(.*)$/;
const clean = (text: string) => text.replace(/[\r\n]+/g, ' ');
// A heading pasted/typed into an item stays an item. Only makeSection creates headings.
const plain = (text: string) => /^ {0,3}#{1,6}(?:[ \t]|$)/.test(text) ? `\\${text}` : text;
export const memoBody = (doc: MemoDocument) => doc.lines.map(line => line.raw + line.ending).join('');
const eolOf = (doc: MemoDocument) => doc.lines.find(line => line.ending)?.ending ?? '\n';

/** Session identities are separate from persisted text. Equal prefix/suffix rows survive external saves/undo. */
export function parseMemo(body: string, previous?: MemoDocument): MemoDocument {
  const parts: Array<{ raw: string; ending: string }> = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (match[0] === '') break;
    parts.push({ raw: match[1]!, ending: match[2]! });
  }
  if (/[\r\n]$/.test(body)) parts.push({ raw: '', ending: '' });
  if (!parts.length) parts.push({ raw: '', ending: '' });
  let nextId = previous?.nextId ?? 0;
  const old = previous?.lines ?? [];
  let first = 0;
  while (first < parts.length && first < old.length && parts[first]!.raw === old[first]!.raw) first++;
  let tail = 0;
  while (tail < parts.length - first && tail < old.length - first && parts[parts.length - 1 - tail]!.raw === old[old.length - 1 - tail]!.raw) tail++;
  const ids = new Map<number, string>();
  const candidates = new Map<string, string[]>();
  const used = new Set<string>();
  for (let i = 0; i < first; i++) { ids.set(i, old[i]!.id); used.add(old[i]!.id); }
  for (let i = parts.length - tail; i < parts.length; i++) {
    const id = old[old.length - parts.length + i]!.id; ids.set(i, id); used.add(id);
  }
  for (let i = first; i < old.length - tail; i++) {
    const line = old[i]!;
    const group = candidates.get(line.raw) ?? []; group.push(line.id); candidates.set(line.raw, group);
  }
  for (let i = first; i < parts.length - tail; i++) {
    const id = candidates.get(parts[i]!.raw)?.shift();
    if (id) { ids.set(i, id); used.add(id); }
  }
  const lines = parts.map((part, i) => {
    let id = ids.get(i);
    if (!id && parts.length === old.length && old[i] && !used.has(old[i]!.id)) id = old[i]!.id;
    id ??= `line-${nextId++}`;
    used.add(id);
    return { ...part, id };
  });
  return { lines, nextId };
}

export function memoSections(doc: MemoDocument): MemoSection[] {
  const sections: MemoSection[] = [{ id: TOP_SECTION, title: null, heading: null, items: [] }];
  const headings = new Map(splitSections(memoBody(doc)).sections.map(section => [section.headingRange.start, section]));
  let offset = 0;
  let current = sections[0]!;
  let fence: ReturnType<typeof fenceStart> = null;
  for (const line of doc.lines) {
    const heading = headings.get(offset);
    offset += line.raw.length + line.ending.length;
    if (heading) {
      current = { id: line.id, title: heading.title, heading, items: [] };
      sections.push(current);
      continue;
    }
    const nextFence = fenceStart(line.raw);
    const fenced = !!fence || !!nextFence;
    if (fence) { if (fenceEnd(line.raw, fence)) fence = null; }
    else fence = nextFence;
    const task = fenced ? null : taskPattern.exec(line.raw);
    current.items.push({ ...line, sectionId: current.id, fenced, task: !!task, done: !!task && task[2] !== ' ', text: task ? task[5]! : line.raw.replace(/^\\(?= {0,3}#{1,6}(?:[ \t]|$))/, '') });
  }
  return sections;
}
export function memoItems(doc: MemoDocument) { return memoSections(doc).flatMap(section => section.items); }
export function memoMode(body: string): MemoMode {
  const items = memoItems(parseMemo(body)).filter(item => item.raw.trim());
  return items.some(item => item.task) && items.every(item => item.task) ? 'todo' : 'text';
}
const findItem = (doc: MemoDocument, id: string) => memoItems(doc).find(item => item.id === id);
function replaceLine(doc: MemoDocument, id: string, raw: string): MemoDocument {
  return { ...doc, lines: doc.lines.map(line => line.id === id ? { ...line, raw } : line) };
}
export function editItem(doc: MemoDocument, id: string, text: string, mode: MemoMode): MemoDocument {
  const item = findItem(doc, id); if (!item) return doc;
  const value = clean(text);
  if (mode === 'todo') {
    const task = taskPattern.exec(item.raw);
    return replaceLine(doc, id, task ? `${task[1]}${task[2]}${task[3]}${task[4] || (value ? ' ' : '')}${value}` : `- [ ]${value ? ` ${value}` : ''}`);
  }
  return replaceLine(doc, id, plain(value));
}
export function toggleItem(doc: MemoDocument, id: string): MemoDocument {
  const item = findItem(doc, id); if (!item?.task) return doc;
  return replaceLine(doc, id, item.raw.replace(taskPattern, (_all, prefix, state, suffix, spacing, text) => `${prefix}${state === ' ' ? 'x' : ' '}${suffix}${spacing}${text}`));
}
function insertAt(doc: MemoDocument, at: number, raw: string): MemoDocument {
  const lines = [...doc.lines]; const eol = eolOf(doc);
  if (at > 0 && !lines[at - 1]!.ending) lines[at - 1] = { ...lines[at - 1]!, ending: eol };
  lines.splice(at, 0, { id: `line-${doc.nextId}`, raw, ending: at < lines.length ? eol : '' });
  return { lines, nextId: doc.nextId + 1 };
}
export function removeItem(doc: MemoDocument, id: string): MemoDocument {
  if (!findItem(doc, id)) return doc;
  const index = doc.lines.findIndex(line => line.id === id);
  const lines = doc.lines.filter(line => line.id !== id);
  if (index === doc.lines.length - 1 && lines.length) lines[lines.length - 1] = { ...lines[lines.length - 1]!, ending: doc.lines[index]!.ending };
  return lines.length ? { ...doc, lines } : { ...doc, lines: [{ id: `line-${doc.nextId}`, raw: '', ending: '' }], nextId: doc.nextId + 1 };
}
export function splitItem(doc: MemoDocument, id: string, start: number, end = start, mode: MemoMode = memoMode(memoBody(doc))): MemoDocument {
  const item = findItem(doc, id); if (!item) return doc;
  const edited = editItem(doc, id, item.text.slice(0, start), mode);
  return insertAt(edited, edited.lines.findIndex(line => line.id === id) + 1, mode === 'todo' ? `- [ ]${item.text.slice(end) ? ` ${item.text.slice(end)}` : ''}` : plain(item.text.slice(end)));
}
/** Joins only items in the same section; section headings are never removed by Backspace. */
export function joinItem(doc: MemoDocument, id: string, mode: MemoMode = memoMode(memoBody(doc))): MemoDocument {
  const section = memoSections(doc).find(section => section.items.some(item => item.id === id));
  const target = section?.items.find(item => item.id === id);
  // In 할 일, open and done items are shown apart; an item joins the previous one in its own group.
  const peers = mode === 'todo' ? section?.items.filter(item => item.task && item.done === target?.done) : section?.items;
  const index = peers?.findIndex(item => item.id === id) ?? -1;
  if (!section || index <= 0) return doc;
  const item = peers![index]!; const previous = peers![index - 1]!;
  return removeItem(editItem(doc, previous.id, previous.text + item.text, mode), id);
}
export function appendToSection(doc: MemoDocument, sectionId: string, text = '', mode: MemoMode = memoMode(memoBody(doc))): MemoDocument {
  const sections = memoSections(doc); const section = sections.find(section => section.id === sectionId); if (!section) return doc;
  const lastOpen = [...section.items].reverse().find(item => mode !== 'todo' || (item.task && !item.done));
  const headingIndex = doc.lines.findIndex(line => line.id === sectionId);
  const at = lastOpen ? doc.lines.findIndex(line => line.id === lastOpen.id) + 1 : headingIndex + 1;
  if (memoBody(doc) === '' && text && sectionId === TOP_SECTION) return editItem(doc, doc.lines[0]!.id, text, mode);
  return insertAt(doc, at, mode === 'todo' ? `- [ ]${text ? ` ${clean(text)}` : ''}` : plain(clean(text)));
}
export function moveItem(doc: MemoDocument, id: string, target: string, mode: MemoMode = memoMode(memoBody(doc))): MemoDocument {
  const item = findItem(doc, id); if (!item || item.sectionId === target) return doc;
  // Append before removing so a lone top item cannot create a synthetic row in the destination.
  const appended = appendToSection(doc, target, item.text, mode);
  if (appended === doc) return doc;
  const newId = `line-${doc.nextId}`;
  const removed = removeItem(appended, id);
  return { ...removed, lines: removed.lines.map(line => line.id === newId ? { ...line, id, raw: item.raw } : line) };
}
export function makeSection(doc: MemoDocument, id: string): MemoDocument {
  const item = findItem(doc, id); return item ? replaceLine(doc, id, `## ${clean(item.text).trim()}`) : doc;
}
export function renameMemoSection(doc: MemoDocument, id: string, title: string): MemoDocument {
  const section = memoSections(doc).find(section => section.id === id);
  return section?.heading ? parseMemo(renameSection(memoBody(doc), section.heading, title), doc) : doc;
}
export function unmakeSection(doc: MemoDocument, id: string, mode: MemoMode = memoMode(memoBody(doc))): MemoDocument {
  const section = memoSections(doc).find(section => section.id === id);
  if (!section?.heading) return doc;
  return replaceLine(doc, id, mode === 'todo' ? `- [ ]${section.title ? ` ${section.title}` : ''}` : plain(section.title ?? ''));
}
export function deleteMemoSection(doc: MemoDocument, id: string): MemoDocument {
  const section = memoSections(doc).find(section => section.id === id);
  return section?.heading ? parseMemo(deleteSection(memoBody(doc), section.heading), doc) : doc;
}
export function moveMemoSection(doc: MemoDocument, id: string, direction: 'up' | 'down'): MemoDocument {
  const sections = memoSections(doc).filter(section => section.heading); const index = sections.findIndex(section => section.id === id);
  const target = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || target < 0 || target >= sections.length) return doc;
  const starts = sections.map(section => doc.lines.findIndex(line => line.id === section.id));
  const low = Math.min(index, target), high = Math.max(index, target);
  const a = starts[low]!, b = starts[high]!, end = starts[high + 1] ?? doc.lines.length;
  const right = doc.lines.slice(b, end);
  if (!right[right.length - 1]!.ending) right[right.length - 1] = { ...right[right.length - 1]!, ending: eolOf(doc) };
  const lines = [...doc.lines.slice(0, a), ...right, ...doc.lines.slice(a, b), ...doc.lines.slice(end)];
  lines[lines.length - 1] = { ...lines[lines.length - 1]!, ending: doc.lines[doc.lines.length - 1]!.ending };
  return { ...doc, lines };
}
export function switchMode(doc: MemoDocument, mode: MemoMode): MemoDocument {
  const items = new Map(memoItems(doc).map(item => [item.id, item]));
  let lines = doc.lines.flatMap(line => {
    const item = items.get(line.id); if (!item) return [line];
    if (mode === 'text') return [{ ...line, raw: item.task ? plain(item.text) : line.raw }];
    if (!line.raw.trim()) return [];
    return [{ ...line, raw: item.task ? line.raw : `- [ ] ${item.text.replace(/^\s*(?:[-*+] |\d+\. )/, '')}` }];
  });
  let next = { ...doc, lines };
  if (mode === 'todo' && !lines.some(line => taskPattern.test(line.raw))) next = insertAt(next, lines.length, '- [ ]');
  if (!next.lines.length) next = parseMemo('', doc);
  return next;
}
export function pasteItems(doc: MemoDocument, id: string, start: number, end: number, text: string, mode: MemoMode): MemoDocument {
  const item = findItem(doc, id); if (!item) return doc;
  const parts = text.split(/\r\n|\r|\n/);
  const decoded = parts.map(raw => { const task = taskPattern.exec(raw); return { text: task ? task[5]! : raw, done: !!task && task[2] !== ' ' }; });
  let next = editItem(doc, id, item.text.slice(0, start) + decoded[0]!.text + (parts.length === 1 ? item.text.slice(end) : ''), mode);
  let at = next.lines.findIndex(line => line.id === id) + 1;
  for (let i = 1; i < decoded.length; i++) {
    const part = decoded[i]!; const value = part.text + (i === decoded.length - 1 ? item.text.slice(end) : '');
    next = insertAt(next, at++, mode === 'todo' ? `- [${part.done ? 'x' : ' '}]${value ? ` ${value}` : ''}` : plain(value));
  }
  if (mode === 'todo' && taskPattern.test(parts[0]!) && decoded[0]!.done !== item.done) next = toggleItem(next, id);
  return next;
}
export function sectionCopy(section: MemoSection, mode: MemoMode): string {
  return (mode === 'todo' ? section.items.filter(item => item.task && !item.done).map(item => `- ${item.text}`) : section.items.map(item => item.text)).join('\n');
}
export function memoPreview(body: string): string {
  const doc = parseMemo(body); const sections = memoSections(doc);
  return sections.flatMap(section => [...(section.title !== null ? [section.title] : []), ...section.items.map(item => item.text)]).join('\n');
}
