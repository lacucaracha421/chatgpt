import type { ReactNode } from "react";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { Badge } from "../shared/ui/Badge";
import { Button } from "../shared/ui/Button";
import { DDay } from "../shared/ui/DDay";
import { Menu } from "../shared/ui/Menu";
import { displayDate } from "../shared/displayDate";
import type { HomeReleaseCard } from "./HomeAttention";
import { HomeSection } from "./HomeAttention";
import { releaseDisplayTitle } from "./HomeReleaseGrid";
import type { CalendarDay, ReleaseCalendarModel } from "./homeCalendarModel";
import "./homeCalendar.css";

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
const MAX_STACK = 3;

type Props = {
  model: ReleaseCalendarModel<HomeReleaseCard>;
  /** The local day the grid is read on. */
  at: Date;
  /** Opens the release calendar view. */
  onOpenCalendar: () => void;
  onOpenNote?: (noteId: string) => void;
  /** A client's own controls beside the section's links (the tablet's week arrows). */
  extraActions?: ReactNode;
};

/** Cover stack of one cell: the first cover in front, up to two more behind it. */
function Stack({ entries }: { entries: HomeReleaseCard[] }) {
  const first = entries[0]!;
  return <span className="home-cal__stack" data-stack={Math.min(entries.length, MAX_STACK)}>
    {entries.slice(0, MAX_STACK).map((entry, index) => <span className="home-cal__cover" key={entry.key}>
      {entry.cover}
      {index === 0 && first.fresh && <Badge variant="accent" className="home-cal__new">NEW</Badge>}
    </span>)}
    {entries.length > 1 && <Badge variant="scrim" className="home-cal__more">+{entries.length - 1}</Badge>}
  </span>;
}

function Caption({ entry }: { entry: HomeReleaseCard }) {
  return <>
    <b>{releaseDisplayTitle(entry.name)}</b>
    {entry.detail && <small>{entry.detail}</small>}
  </>;
}

function Cell({ day, at, onOpenNote }: { day: CalendarDay<HomeReleaseCard>; at: Date; onOpenNote?: (noteId: string) => void }) {
  const { entries } = day;
  const first = entries[0];
  // The grid's first day and each first of a month carry the month; the rest only the day.
  const headLabel = day.index === 0 || day.day === 1 ? displayDate(day.date, at) : String(day.day);
  return <div className="home-cal__day" data-tense={day.tense} data-has={first ? "" : undefined}>
    <div className="home-cal__head">
      <span className="home-cal__date numeric">{headLabel}</span>
      {/* A photo mark and "장" keep the saved count from reading as a date (user 2026-10-15). */}
      {day.savedCount > 0 && <span className="home-cal__saved" aria-label={`저장한 이미지 ${day.savedCount.toLocaleString()}장`}>
        <PhotoIcon aria-hidden="true" /><span className="numeric">{day.savedCount.toLocaleString()}</span>장
      </span>}
      {/* Today is marked only by the filled square behind its date. */}
      {day.tense === "future" && first && <DDay days={day.daysFromToday} />}
    </div>
    {first && (entries.length === 1
      ? <button type="button" className="home-cal__item" onClick={first.onOpen}>
          <Stack entries={entries} />
          <Caption entry={first} />
        </button>
      : <Menu label={`${displayDate(day.date, at)} 발매 ${entries.length}개`} triggerClassName="home-cal__item" align="start"
          items={entries.map(entry => ({ id: entry.key, label: [releaseDisplayTitle(entry.name), entry.detail, entry.fresh ? "NEW" : ""].filter(Boolean).join(" · "), onSelect: entry.onOpen }))}
          trigger={<><Stack entries={entries} /><Caption entry={first} /></>} />)}
    <div className="home-cal__payments">
      {day.payments.slice(0, 2).map(payment => <Button key={payment.key} variant="quiet" className="home-cal__payment" disabled={!onOpenNote} title={payment.label} onClick={() => onOpenNote?.(payment.noteId)}>
        <span className="home-cal__payment-label">{payment.label}</span>
      </Button>)}
      {day.paymentOverflow > 0 && <Menu label={`${displayDate(day.date, at)} 결제 일정 ${day.paymentOverflow}개 더 보기`}
        triggerClassName="ui-button ui-button--quiet ui-button--md home-cal__payment" align="start" disabled={!onOpenNote}
        items={day.payments.slice(2).map(payment => ({ id: payment.key, label: payment.label, onSelect: () => onOpenNote?.(payment.noteId) }))}
        trigger={<span className="home-cal__payment-label numeric">+{day.paymentOverflow}</span>} />}
    </div>
  </div>;
}

export function HomeCalendar({ model, at, onOpenCalendar, onOpenNote, extraActions }: Props) {
  const { days, earlier, later } = model;
  const actions = <>
    {extraActions}
    {earlier.length > 0 && <Menu label={`지난 NEW ${earlier.length}개`} triggerClassName="home-link" align="end"
      items={earlier.map(entry => ({ id: entry.key, label: [releaseDisplayTitle(entry.name), entry.date ? displayDate(entry.date, at) : "", entry.detail].filter(Boolean).join(" · "), onSelect: entry.onOpen }))}
      trigger={<>지난 NEW <span className="numeric">{earlier.length}개</span></>} />}
    {later && <button type="button" className="home-link" onClick={onOpenCalendar}>{displayDate(later.from, at)} 이후 <span className="numeric">{later.entries.length}개</span></button>}
  </>;
  return <HomeSection title="발매 캘린더" onOpen={onOpenCalendar} actions={actions}>
    <div className="home-cal">
      {WEEKDAYS.map((weekday, index) => <span key={weekday} className="home-cal__weekday" data-weekend={index > 4 ? "" : undefined}>{weekday}</span>)}
      {days.map(day => <Cell key={day.date} day={day} at={at} onOpenNote={onOpenNote} />)}
    </div>
  </HomeSection>;
}
