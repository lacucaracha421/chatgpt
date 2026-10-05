import { EyeSlashIcon, LockClosedIcon, WalletIcon } from "@heroicons/react/24/outline";
import { byOrder, checklistMarkdown, noteColorValue } from "./model";
import { isSecret, type Note } from "./store";
import { LEDGER } from "./ledger/model";
import { ledgerCard } from "./ledger/card";
import { memoItems, memoMode, memoPreview, parseMemo } from "./memo/memoModel";
import { noteDateLabel } from "./format";
import type { CSSProperties } from "react";
import { PinSolidIcon } from "../shared/ui/PinIcon";

const CHECKLIST_ROWS = 8;
const BODY_LINES = 12;

/** Plain preview with section and task markers removed; retains line breaks and literal formatting. */
export function previewLines(body: string): string {
  return memoPreview(body).split(/\r\n|\n|\r/).slice(0, BODY_LINES + 1).join("\n").trimEnd();
}

export function CardBody({ note, notes }: { note: Note; notes: Note[] }) {
  if (note.concealed && !isSecret(note)) {
    return <span className="notes-card__concealed"><EyeSlashIcon aria-hidden="true" />숨긴 메모 · 열어서 보기</span>;
  }
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
  const body = note.type === "checklist" ? checklistMarkdown(note.items ?? []) : note.body;
  if (note.type === "checklist" || memoMode(body) === "todo") {
    const items = memoItems(parseMemo(body)).filter(item => item.task).map(item => ({ id: item.id, text: item.text, checked: item.done })).sort((a,b) => Number(a.checked)-Number(b.checked));
    if (!items.length) return <span className="notes-card__text is-empty">빈 체크리스트</span>;
    const done = items.filter((item) => item.checked).length;
    const shown = items.slice(0, CHECKLIST_ROWS);
    return <>
      <span className="notes-card__progress"><span className="notes-card__progress-bar" aria-hidden="true"><span style={{ width: `${(done / items.length) * 100}%` }} /></span><span>{done}/{items.length} 완료</span></span>
      <span className="notes-card__checklist">
        {shown.map((item) => <span key={item.id} className={`notes-card__check${item.checked ? " is-done" : ""}`}><span className="notes-card__box" aria-hidden="true" /><span className="notes-card__check-text">{item.text.trim() || " "}</span></span>)}
        {items.length > shown.length && <span className="notes-card__more">외 {items.length - shown.length}개</span>}
      </span>
    </>;
  }
  const text = previewLines(note.body);
  return <span className={`notes-card__text${text ? "" : " is-empty"}`}>{text || "내용 없음"}</span>;
}

export type NoteCardProps = {
  note: Note;
  notes: Note[];
  selected?: boolean;
  onOpen: (id: string) => void;
  style?: CSSProperties;
};

export function NoteCard({ note, notes, selected = false, onOpen, style }: NoteCardProps) {
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
    {note.pinned && <PinSolidIcon className="notes-card__pin" aria-label="고정됨" />}
    <CardBody note={note} notes={notes} />{" "}
    <span className="notes-card__foot">
      <span className="notes-card__labels">{labels.map((label) => <span key={label} className="notes-card__label">{label}</span>)}</span>
      <time dateTime={note.updatedAt}>{note.pending && <span className="notes-card__pending" role="img" aria-label="동기화 대기" />}{noteDateLabel(note.updatedAt)}</time>
    </span>
  </button>;
}
