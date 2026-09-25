import { CLASSIFICATION_COLORS } from "../classification/classificationAppearance";

/** Notes v2 plaintext model helpers shared by the PC notes UI (see ADR-0035 amendment). */
export type NoteKind = "text" | "checklist" | "secret";
export type ChecklistItem = { id: string; text: string; checked: boolean; order: string; [extra: string]: unknown };
export type SecretField = { id: string; label: string; value: string; order: string; [extra: string]: unknown };

export const NOTE_LIMITS = { title: 200, items: 500, itemChars: 1000, labels: 20, labelChars: 40, fields: 200, fieldLabelChars: 100, fieldValueChars: 4000 } as const;

/** Eight palette keys taken from the classification palette; `null` is the default surface. */
export const NOTE_COLOR_KEYS = ["red", "orange", "amber", "green", "teal", "blue", "indigo", "pink"] as const;
export const NOTE_COLORS = NOTE_COLOR_KEYS.map((key) => CLASSIFICATION_COLORS.find((color) => color.key === key)!);
/** Swatch value for a known key; an unknown key renders as no colour (and is kept on save). */
export function noteColorValue(key: string | null | undefined): string | null {
  return NOTE_COLORS.find((color) => color.key === key)?.value ?? null;
}

// ---------------------------------------------------------------------------------------
// Fractional order keys: base-62 digits in ASCII order, never ending in "0". Clients sort
// by (order, id) with plain code-unit comparison, so a move rewrites only the moved item.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const low = a ? DIGITS.indexOf(a[0]!) : 0;
  const high = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low]! + midpoint(a.slice(1), null);
}

/** Appending steps the first digit that can grow, so keys lengthen once per ~60 appends. */
function keyAfter(a: string): string {
  for (let i = 0; i < a.length; i++) {
    const digit = DIGITS.indexOf(a[i]!);
    if (digit < DIGITS.length - 1) return a.slice(0, i) + DIGITS[digit + 1];
  }
  return a + DIGITS[DIGITS.length / 2];
}
function keyBefore(b: string): string {
  for (let i = 0; i < b.length; i++) {
    const digit = DIGITS.indexOf(b[i]!);
    if (digit > 1) return b.slice(0, i) + DIGITS[digit - 1];
    if (digit === 1 && i < b.length - 1) return b.slice(0, i + 1);
  }
  return midpoint("", b);
}

/** Order keys stay short; a longer one makes the caller renumber its group. */
const MAX_KEY_LENGTH = 48;

/** A key strictly between `a` and `b` (either may be open). Throws when a >= b. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error("order keys out of order");
  if (a === null && b === null) return DIGITS[DIGITS.length / 2]!;
  if (b === null) return keyAfter(a!);
  if (a === null) return keyBefore(b);
  return midpoint(a, b);
}

/** Fresh ascending keys for `count` entries. */
export function sequentialKeys(count: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < count; i++) keys.push(i ? keyAfter(keys[i - 1]!) : "1");
  return keys;
}

export function byOrder<T extends { order: string; id: string }>(a: T, b: T): number {
  return a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Places entry `id` at `index` of the displayed `group` (already sorted, may include `id`)
 * by rewriting only its order key; renumbers the group when neighbouring keys collide.
 */
export function placeInGroup<T extends { order: string; id: string }>(all: T[], group: T[], id: string, index: number): T[] {
  const moving = all.find((entry) => entry.id === id);
  if (!moving) return all;
  const rest = group.filter((entry) => entry.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  const before = rest[at - 1] ?? null;
  const after = rest[at] ?? null;
  try {
    const order = keyBetween(before?.order ?? null, after?.order ?? null);
    if (order.length > MAX_KEY_LENGTH) throw new Error("order key too long");
    return all.map((entry) => (entry.id === id ? { ...entry, order } : entry));
  } catch {
    const arranged = [...rest.slice(0, at), moving, ...rest.slice(at)];
    const keys = sequentialKeys(arranged.length);
    const next = new Map(arranged.map((entry, i) => [entry.id, keys[i]!]));
    return all.map((entry) => (next.has(entry.id) ? { ...entry, order: next.get(entry.id)! } : entry));
  }
}

// ---------------------------------------------------------------------------------------
// Conversions and fallback text

function oneLine(text: string) {
  return text.split(/[\r\n]+/).filter(Boolean).join(" ");
}

/** GFM task list in display order (open items, then completed), as the Rust fallback. */
export function checklistMarkdown(items: ChecklistItem[]): string {
  const sorted = [...items].sort((a, b) => Number(a.checked) - Number(b.checked) || byOrder(a, b));
  return sorted.map((item) => `- [${item.checked ? "x" : " "}] ${oneLine(item.text)}`).join("\n");
}

/** Text → checklist: task lines keep their state; other non-empty lines become open items. */
export function textToItems(body: string): ChecklistItem[] {
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, NOTE_LIMITS.items);
  const keys = sequentialKeys(lines.length);
  return lines.map((line, index) => {
    const task = /^(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s*(.*)$/.exec(line);
    const bullet = /^(?:[-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    const text = (task ? task[2]! : bullet ? bullet[1]! : line).slice(0, NOTE_LIMITS.itemChars);
    return { id: crypto.randomUUID(), text, checked: !!task && task[1] !== " ", order: keys[index]! };
  });
}

/** Cheap Markdown-free preview text; never runs the renderer. */
export function stripMarkdown(body: string): string {
  return body
    .replace(/^```.*$/gm, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|\*|_|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------------------
// Labels

/** Code points, as the backend counts them (not UTF-16 units). */
export const codePoints = (text: string) => Array.from(text).length;
export function normalizeLabel(label: string): string {
  return Array.from(label.normalize("NFC").replace(/\s+/g, " ").trim()).slice(0, NOTE_LIMITS.labelChars).join("").trim();
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const KIB = 1024;
type LimitedNote = { title: string; body: string; type?: string; labels?: string[]; items?: ChecklistItem[]; fields?: SecretField[]; memo?: string };
/** The backend's whole-note limits, checked before a draft is queued. Returns a message or null. */
export function noteLimitProblem(note: LimitedNote): string | null {
  if (codePoints(note.title) > NOTE_LIMITS.title) return "제목은 200자까지 쓸 수 있습니다.";
  const labels = note.labels ?? [];
  if (labels.length > NOTE_LIMITS.labels) return "라벨은 메모마다 20개까지 붙일 수 있습니다.";
  if (labels.some((label) => codePoints(label) > NOTE_LIMITS.labelChars)) return "라벨은 40자까지 쓸 수 있습니다.";
  const items = note.items ?? [];
  if (items.length > NOTE_LIMITS.items) return "체크리스트 항목은 500개까지 만들 수 있습니다.";
  if (items.some((item) => codePoints(item.text) > NOTE_LIMITS.itemChars)) return "체크리스트 항목은 1000자까지 쓸 수 있습니다.";
  const fields = note.fields ?? [];
  if (fields.length > NOTE_LIMITS.fields) return "암호 메모 항목은 200개까지 만들 수 있습니다.";
  if (fields.some((field) => codePoints(field.label) > NOTE_LIMITS.fieldLabelChars || codePoints(field.value) > NOTE_LIMITS.fieldValueChars))
    return "암호 메모 항목 이름은 100자, 값은 4000자까지 쓸 수 있습니다.";
  const body = note.type === "checklist" ? checklistMarkdown(items) : note.type === "secret" ? fields.map((f) => `${f.label}: ${f.value}`).join("\n") + "\n\n" + (note.memo ?? "") : note.body;
  if (utf8Bytes(body) > 128 * KIB || utf8Bytes(note.memo ?? "") > 128 * KIB) return "메모 본문은 128 KiB까지 저장할 수 있습니다. 내용을 줄이거나 메모를 나눠 주세요.";
  const size = utf8Bytes(JSON.stringify({ ...note, body }));
  if (size > 256 * KIB) return "메모 전체는 256 KiB까지 저장할 수 있습니다. 내용을 줄이거나 메모를 나눠 주세요.";
  return null;
}
export function labelKey(label: string): string {
  return label.normalize("NFC").toLowerCase();
}
