/**
 * Notes board: masonry sticky-note cards (mobile design B, chosen 2026-09-26), adapted to the PC
 * notes area. Cards keep their content height and are placed in list order into the currently
 * shortest column, so the newest notes read left to right across the top and keyboard focus
 * follows the same order (a column-major CSS `columns` flow would bury later columns below
 * the fold on a long list).
 */
import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { LockClosedIcon, WalletIcon } from "@heroicons/react/24/outline";
import { BookmarkIcon } from "../shared/ui/ArchiveIcons";
import { byOrder, noteColorValue, stripMarkdown } from "./model";
import { isSecret, noteKind, type Note } from "./store";
import { LEDGER } from "./ledger/model";
import { ledgerCard } from "./ledger/LedgerView";

export const CARD_MIN_WIDTH = 240;
export const CARD_GAP = 12;
const CHECKLIST_ROWS = 8;
const BODY_LINES = 12;

/** Column count and card width for a board `width` px wide (0 = not measured yet). */
export function boardColumns(width: number, minWidth = CARD_MIN_WIDTH, gap = CARD_GAP) {
  if (width <= 0) return { columns: 0, cardWidth: 0 };
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  return { columns, cardWidth: (width - gap * (columns - 1)) / columns };
}

/** Places cards in order into the shortest column (leftmost on ties). */
export function placeCards(heights: number[], columns: number, cardWidth: number, gap = CARD_GAP) {
  const bottoms = Array<number>(Math.max(1, columns)).fill(0);
  const positions = heights.map((height) => {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const position = { left: column * (cardWidth + gap), top: bottoms[column]! };
    bottoms[column] += height + gap;
    return position;
  });
  return { positions, height: Math.max(0, Math.max(...bottoms) - gap) };
}

/** Text preview that keeps line breaks but not Markdown syntax; never runs the renderer. */
export function previewLines(body: string): string {
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    if (/^\s*```/.test(raw)) continue;
    const line = stripMarkdown(raw);
    if (!line && (!lines.length || !lines[lines.length - 1])) continue;
    lines.push(line);
    if (lines.length >= BODY_LINES + 1) break;
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join("\n");
}

function cardDate(value: string, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" })
    : date.toLocaleDateString("ko-KR", { year: "numeric", month: "short", day: "numeric" });
}

function CardBody({ note, notes }: { note: Note; notes: Note[] }) {
  if (isSecret(note)) {
    // Values are always masked on the board; field names only exist while a PIN session is open.
    const fields = note.redacted ? [] : [...(note.fields ?? [])].sort(byOrder).slice(0, 4);
    return <span className="notes-card__secret">
      <span className="notes-card__secret-caption">암호 메모{note.redacted ? " · PIN으로 잠김" : ""}</span>
      {(fields.length ? fields.map((field) => field.label.trim() || "항목") : ["", ""]).map((label, index) =>
        <span key={index} className="notes-card__secret-row"><span>{label}</span><span aria-hidden="true">••••••</span></span>)}
    </span>;
  }
  if (note.type === LEDGER && !note.readOnly && !note.deleted) {
    const card = ledgerCard(note, notes);
    return <span className="notes-card__ledger">
      <span className="notes-card__ledger-label">{card.label}</span>{" "}
      <span className={`notes-card__ledger-amount${card.over ? " is-over" : ""}`}>{card.amount}</span>
      {card.spentRatio !== null && <span className="notes-card__meter" aria-hidden="true"><span style={{ width: `${card.spentRatio * 100}%` }} /></span>}
      {card.next && <span className="notes-card__ledger-next">{card.next}</span>}
    </span>;
  }
  if (noteKind(note) === "checklist" && !note.readOnly) {
    const items = [...(note.items ?? [])].sort((a, b) => Number(a.checked) - Number(b.checked) || byOrder(a, b));
    if (!items.length) return <span className="notes-card__text is-empty">빈 체크리스트</span>;
    const done = items.filter((item) => item.checked).length;
    const shown = items.slice(0, CHECKLIST_ROWS);
    return <>
      <span className="notes-card__progress"><span className="notes-card__progress-bar" aria-hidden="true"><span style={{ width: `${(done / items.length) * 100}%` }} /></span><span>{done}/{items.length}</span></span>
      <span className="notes-card__checklist">
        {shown.map((item) => <span key={item.id} className={`notes-card__check${item.checked ? " is-done" : ""}`}><span className="notes-card__box" aria-hidden="true" /><span className="notes-card__check-text">{item.text.trim() || " "}</span></span>)}
        {items.length > shown.length && <span className="notes-card__more">외 {items.length - shown.length}개</span>}
      </span>
    </>;
  }
  const text = previewLines(note.body);
  return <span className={`notes-card__text${text ? "" : " is-empty"}`}>{text || "내용 없음"}</span>;
}

type CardProps = { note: Note; notes: Note[]; selected: boolean; onOpen: (id: string) => void; style?: CSSProperties };
function NoteCard({ note, notes, selected, onOpen, style }: CardProps) {
  const color = noteColorValue(note.color);
  const title = note.title.trim();
  const labels = isSecret(note) ? [] : note.labels ?? [];
  return <button type="button" data-note-id={note.id} className={`notes-card${selected ? " is-selected" : ""}${color ? " has-tint" : ""}${note.pinned ? " is-pinned" : ""}`}
    style={{ ...style, ...(color ? { "--note-tint": color } : {}) } as CSSProperties} aria-current={selected ? "true" : undefined} onClick={() => onOpen(note.id)}>
    <span className={`notes-card__title${title ? "" : " is-untitled"}`}>
      {isSecret(note) && <LockClosedIcon aria-label="암호 메모" />}
      {note.type === LEDGER && <WalletIcon aria-hidden="true" />}
      <span className="notes-card__title-text">{title || "제목 없는 메모"}</span>
      {note.conflictCopy && <span className="notes-copy-mark">사본</span>}
      {note.conflict && <span className="notes-conflict-mark" aria-description="충돌 확인 필요">!</span>}
    </span>{" "}
    {note.pinned && <BookmarkIcon className="notes-card__pin" aria-label="고정됨" />}
    <CardBody note={note} notes={notes} />{" "}
    <span className="notes-card__foot">
      <span className="notes-card__labels">{labels.map((label) => <span key={label} className="notes-card__label">{label}</span>)}</span>
      <time dateTime={note.updatedAt}>{note.pending && <span className="notes-card__pending" role="img" aria-label="동기화 대기" />}{cardDate(note.updatedAt)}</time>
    </span>
  </button>;
}

type MasonryProps = { notes: Note[]; all: Note[]; selected: string | null; onOpen: (id: string) => void };
/** One masonry section. Before its width is known (first frame, tests) it falls back to a CSS grid. */
export const NoteMasonry = memo(function NoteMasonry({ notes, all, selected, onOpen }: MasonryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const { columns, cardWidth } = boardColumns(width);
  // Measure after every render (content, width or column changes); state only changes when a size did.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      setWidth((current) => (current === element.clientWidth ? current : element.clientWidth));
      const next: Record<string, number> = {};
      element.querySelectorAll<HTMLElement>(":scope > [data-note-id]").forEach((card) => { next[card.dataset.noteId!] = card.offsetHeight; });
      setHeights((current) => {
        const keys = Object.keys(next);
        return keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key]) ? current : next;
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll(":scope > [data-note-id]").forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  });
  const layout = columns ? placeCards(notes.map((note) => heights[note.id] ?? 160), columns, cardWidth) : null;
  return <div ref={ref} className={`notes-masonry${layout ? " is-placed" : ""}`} style={layout ? { height: layout.height } : undefined}>
    {notes.map((note, index) => <NoteCard key={note.id} note={note} notes={all} selected={selected === note.id} onOpen={onOpen}
      style={layout ? { width: cardWidth, transform: `translate(${layout.positions[index]!.left}px, ${layout.positions[index]!.top}px)` } : undefined} />)}
  </div>;
});
