import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetDateBucket } from "../library/types";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

type Month = { year: number; month: number };

export function DateBrowse({ initialMonth, renderDay, onSelectedDateChange }: {
  initialMonth?: string;
  renderDay?: (localDate: string) => ReactNode;
  onSelectedDateChange?: (localDate: string | null) => void;
}) {
  const { gateway } = useLibrary();
  const [cursor, setCursor] = useState<Month>(() => parseMonth(initialMonth));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<AssetDateBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBuckets(null);
    setError(null);
    const start = new Date(cursor.year, cursor.month, 1);
    const end = new Date(cursor.year, cursor.month + 1, 1);
    // ponytail: one month offset is enough for Lakomics' current Korean locale;
    // use per-day UTC ranges if DST-zone support becomes a product requirement.
    void gateway.listAssetDateBuckets({
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      offsetMinutes: -start.getTimezoneOffset(),
    }).then((result) => {
      if (!cancelled) setBuckets(result);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(commandErrorMessage(reason, "수집 기록을 불러오지 못했습니다."));
    });
    return () => { cancelled = true; };
  }, [cursor, gateway]);

  const counts = useMemo(() => new Map((buckets ?? []).map((entry) => [entry.date, entry.count])), [buckets]);
  const activeDates = useMemo(() => [...counts.keys()].sort(), [counts]);
  const cells = useMemo(() => monthCells(cursor), [cursor]);
  const maximum = Math.max(0, ...counts.values());
  const total = (buckets ?? []).reduce((sum, entry) => sum + entry.count, 0);

  if (selectedDate) {
    const index = activeDates.indexOf(selectedDate);
    const previous = index > 0 ? activeDates[index - 1] : null;
    const next = index >= 0 && index < activeDates.length - 1 ? activeDates[index + 1] : null;
    return <section className="revisit-date revisit-date--selected" aria-label="선택한 날짜">
      <header className="revisit-date__compact-header">
        <Button size="icon" variant="ghost" aria-label="이전 저장일" disabled={!previous} onClick={() => previous && selectDate(previous)}>‹</Button>
        <h3>{formatDay(selectedDate)}</h3>
        <span>{counts.get(selectedDate)?.toLocaleString("ko-KR") ?? 0}개</span>
        <Button size="icon" variant="ghost" aria-label="다음 저장일" disabled={!next} onClick={() => next && selectDate(next)}>›</Button>
        <Button variant="ghost" onClick={() => selectDate(null)}>달력 펼치기</Button>
      </header>
      {renderDay?.(selectedDate)}
    </section>;
  }

  if (error) return <EmptyState title={error} />;
  if (buckets === null) return <Skeleton className="revisit-date__skeleton" label="수집 기록을 불러오는 중" />;

  const shiftMonth = (delta: number) => setCursor((current) => {
    const date = new Date(current.year, current.month + delta, 1);
    return { year: date.getFullYear(), month: date.getMonth() };
  });

  return <section className="revisit-date" aria-label="수집 달력">
    <header className="revisit-date__month-header">
      <Button size="icon" variant="ghost" aria-label="이전 달" onClick={() => shiftMonth(-1)}>‹</Button>
      <h3>{cursor.year}년 {cursor.month + 1}월 · {total.toLocaleString("ko-KR")}개 · {activeDates.length}일 저장</h3>
      <Button size="icon" variant="ghost" aria-label="다음 달" onClick={() => shiftMonth(1)}>›</Button>
    </header>
    <div className="revisit-date__grid" role="grid">
      {WEEKDAYS.map((weekday) => <span key={weekday} className="revisit-date__weekday">{weekday}</span>)}
      {cells.map((date, index) => date === null ? <span key={`blank-${index}`} /> : <DayCell
        key={date}
        date={date}
        count={counts.get(date) ?? 0}
        maximum={maximum}
        onSelect={() => selectDate(date)}
      />)}
    </div>
  </section>;

  function selectDate(localDate: string | null) {
    setSelectedDate(localDate);
    onSelectedDateChange?.(localDate);
  }
}

function DayCell({ date, count, maximum, onSelect }: { date: string; count: number; maximum: number; onSelect: () => void }) {
  const intensity = count === 0 ? 0 : Math.min(1, Math.log2(count + 1) / Math.log2(maximum + 1));
  return <button
    type="button"
    className={`revisit-date__day${count === 0 ? " revisit-date__day--empty" : ""}`}
    style={count === 0 ? undefined : { background: `color-mix(in srgb, var(--color-accent) ${Math.round(intensity * 60)}%, transparent)` }}
    aria-label={`${date} 수집 ${count}개`}
    disabled={count === 0}
    onClick={onSelect}
  >
    <span>{Number(date.slice(-2))}</span>
    {count > 0 && <span className="revisit-date__count">{count.toLocaleString("ko-KR")}</span>}
  </button>;
}

function parseMonth(value?: string): Month {
  const match = value && /^(\d{4})-(\d{2})$/.exec(value);
  if (match) return { year: Number(match[1]), month: Number(match[2]) - 1 };
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function monthCells({ year, month }: Month): Array<string | null> {
  const first = new Date(year, month, 1);
  const cells: Array<string | null> = Array.from({ length: first.getDay() }, () => null);
  const length = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= length; day += 1) {
    cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatDay(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return `${year}년 ${month}월 ${day}일`;
}
