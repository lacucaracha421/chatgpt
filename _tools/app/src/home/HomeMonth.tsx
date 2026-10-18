import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowPathRoundedSquareIcon, ChevronLeftIcon, ChevronRightIcon, DocumentTextIcon, WalletIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { displayCount, displayDate } from "../shared/displayDate";
import { releaseDisplayTitle } from "./HomeReleaseGrid";
import { volumeDetail } from "./ReleaseKindMark";
import { monthOf, monthTitle, movedSelection, savedHeat, shiftMonth, type MonthDay, type MonthRelease } from "./homeMonthModel";
import "./homeCalendar.css";
import "./homeMonth.css";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const WEEKDAY_NAMES = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

/** An amount, or the secret-note dots while privacy mode hides amounts. */
export function Money({ amount, hidden, symbol = false }: { amount: number; hidden: boolean; symbol?: boolean }) {
  if (hidden) return <span className="home-mask" aria-label="금액 숨김">••••</span>;
  return <span className="numeric">{symbol ? `₩${amount.toLocaleString("ko-KR")}` : displayCount(amount, "원")}</span>;
}

export const weekdayName = (date: string) => WEEKDAY_NAMES[new Date(`${date}T12:00:00`).getDay()]!;

type Props = {
  month: string;
  today: string;
  at: Date;
  selected: string;
  days: MonthDay<MonthRelease>[];
  /** Null while the ledger cannot be read (locked); no money shows then. */
  totals: { spent: number; planned: number } | null;
  hideAmounts: boolean;
  /** False on the tablet: charge amounts stay in the day sheet, the cell shows the name only. */
  chargeAmounts?: boolean;
  /** NEW releases the shown grid cannot place (undated or outside the six weeks). */
  earlier: MonthRelease[];
  onMonth(month: string): void;
  onSelect(date: string): void;
  onToday(): void;
  onOpenCalendar(): void;
  /** Enter on a day moves focus into the day panel (the tablet opens that day instead). */
  onEnterPanel(date: string): void;
};

/** Every chip when they fit in three lines; otherwise what fits in two lines and +N for the rest. */
function fitChips(chips: ReactNode[], lines: number[]) {
  const total = lines.reduce((sum, count) => sum + count, 0);
  if (total <= 3) return chips;
  let used = 0, shown = 0;
  while (shown < chips.length && used + lines[shown]! <= 2) used += lines[shown++]!;
  return <>{chips.slice(0, shown)}<span className="home-cal__more numeric">+{chips.length - shown}</span></>;
}

function Cell({ day, heat, selected, tabbable, hideAmounts, chargeAmounts }: { day: MonthDay<MonthRelease>; heat: number; selected: boolean; tabbable: boolean; hideAmounts: boolean; chargeAmounts: boolean }) {
  // A charge with a second line (amount or trial end) takes two chip lines; a cell holds three.
  const twoLines = (payment: MonthDay<MonthRelease>["payments"][number]) => chargeAmounts || payment.kind === "trialEnd";
  const lines = [...day.releases.map(() => 1), ...day.payments.map(payment => twoLines(payment) ? 2 : 1)];
  const chips = [
    ...day.releases.map(release => <span key={`release:${release.key}`} className="home-cal__chip" data-new={release.fresh ? "" : undefined}>
      <span className="home-cal__chip-title">{releaseDisplayTitle(release.name)}</span>
      {volumeDetail(release.detail) && <span className="home-cal__chip-detail">{volumeDetail(release.detail)}</span>}
    </span>),
    ...day.payments.map(payment => <span key={`payment:${payment.key}`} className="home-cal__chip home-cal__chip--pay" data-trial={payment.kind === "trialEnd" ? "" : undefined}>
      <ArrowPathRoundedSquareIcon />
      <span className="home-cal__chip-title">{payment.name}</span>
      {twoLines(payment) && <span className="home-cal__chip-detail">{payment.kind === "trialEnd" ? "무료 끝남" : <Money amount={payment.amount} hidden={hideAmounts} />}</span>}
    </span>),
  ];
  const label = [
    `${Number(day.date.slice(5, 7))}월 ${day.day}일 ${weekdayName(day.date)}`,
    day.holiday,
    day.releases.length ? `발매 ${day.releases.length}개` : "",
    day.releases.some(release => release.fresh) ? `NEW ${day.releases.filter(release => release.fresh).length}개` : "",
    day.savedCount ? `저장 ${day.savedCount.toLocaleString()}장` : "",
    day.payments.length ? `결제 예정 ${day.payments.length}개` : "",
    day.hasMemo ? "메모 있음" : "",
    day.spent && !hideAmounts ? `지출 ${displayCount(day.spent, "원")}` : "",
  ].filter(Boolean).join(", ");
  // Each first of a month carries the month; the rest only the day.
  const head = day.day === 1 ? `${Number(day.date.slice(5, 7))}.1` : String(day.day);
  return <button type="button" role="gridcell" className="home-cal__day" data-day={day.date} data-tense={day.tense} data-heat={heat || undefined}
    data-dow={new Date(`${day.date}T12:00:00Z`).getUTCDay()} data-holiday={day.holiday ? "" : undefined}
    data-outside={day.inMonth ? undefined : ""} aria-selected={selected} aria-label={label} tabIndex={tabbable ? 0 : -1}>
    <span className="home-cal__head" aria-hidden="true">
      <span className="home-cal__date numeric" aria-hidden="true">{head}</span>
      {day.holiday && <span className="home-cal__holiday">{day.holiday}</span>}
      {day.hasMemo && <DocumentTextIcon className="home-cal__memo" />}
    </span>
    <span className="home-cal__chips" aria-hidden="true">
      {fitChips(chips, lines)}
    </span>
    {day.spent > 0 && <span className="home-cal__foot" aria-hidden="true">
      <span className="home-cal__spent"><WalletIcon /><Money amount={day.spent} hidden={hideAmounts} /></span>
    </span>}
  </button>;
}

export function HomeMonth({ month, today, at, selected, days, totals, hideAmounts, chargeAmounts = true, earlier, onMonth, onSelect, onToday, onOpenCalendar, onEnterPanel }: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const focusAfterMove = useRef(false);
  const title = monthTitle(month, today);
  const atToday = month === monthOf(today) && selected === today;
  const selectedInGrid = days.some(day => day.date === selected);
  const tabbableDate = selectedInGrid ? selected : days.find(day => day.inMonth)?.date;

  // A keyboard move follows the selection with focus once the new cell is drawn.
  useEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-day="${selected}"]`)?.focus();
  }, [selected, month]);

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const date = (event.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset.day;
    if (!date || event.nativeEvent.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); onEnterPanel(date); return; }
    const next = movedSelection(date, event.key, today);
    if (!next) return;
    event.preventDefault();
    focusAfterMove.current = true;
    if (monthOf(next) !== month) onMonth(monthOf(next));
    onSelect(next);
  };

  const heatOf = useMemo(() => savedHeat(days.map(day => day.savedCount)), [days]);
  const rows = Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7));
  return <section className="home-month" aria-label="달력">
    <div className="home-month__head">
      <h2 className="home-month__title numeric">{title}</h2>
      <span className="home-month__nav">
        <Button size="icon" variant="ghost" aria-label="이전 달" onClick={() => onMonth(shiftMonth(month, -1))}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Button variant="quiet" disabled={atToday} onClick={onToday}>오늘</Button>
        <Button size="icon" variant="ghost" aria-label="다음 달" onClick={() => onMonth(shiftMonth(month, 1))}><ChevronRightIcon aria-hidden="true" /></Button>
      </span>
      <span className="home-month__spacer" />
      {totals && <dl className="home-month__totals" aria-label={`${title} 가계부`}>
        <div><dt>쓴 돈</dt><dd><Money amount={totals.spent} hidden={hideAmounts} symbol /></dd></div>
        {totals.planned > 0 && <div><dt>예정</dt><dd><Money amount={totals.planned} hidden={hideAmounts} symbol /></dd></div>}
      </dl>}
      {earlier.length > 0 && <Menu label={`지난 NEW ${earlier.length}개`} triggerClassName="home-link" align="end"
        items={earlier.map(entry => ({ id: entry.key, label: [releaseDisplayTitle(entry.name), entry.date ? displayDate(entry.date, at) : "", entry.detail].filter(Boolean).join(" · "), onSelect: entry.onOpen }))}
        trigger={<>지난 NEW <span className="numeric">{earlier.length}개</span></>} />}
      <button type="button" className="home-link" onClick={onOpenCalendar}>발매 캘린더<ChevronRightIcon aria-hidden="true" /></button>
    </div>
    <div ref={grid} className="home-cal home-cal--month" role="grid" aria-label={title} onKeyDown={keys} onClick={event => {
      const date = (event.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset.day;
      if (date) onSelect(date);
    }}>
      <div role="row" className="home-cal__row">
        {WEEKDAYS.map((weekday, index) => <span key={weekday} role="columnheader" className="home-cal__weekday" data-dow={index}>{weekday}</span>)}
      </div>
      {rows.map(row => <div key={row[0]!.date} role="row" className="home-cal__row">
        {row.map(day => <Cell key={day.date} day={day} heat={heatOf(day.savedCount)} selected={day.date === selected} tabbable={day.date === tabbableDate} hideAmounts={hideAmounts} chargeAmounts={chargeAmounts} />)}
      </div>)}
    </div>
  </section>;
}
