import { useMemo, useState } from "react";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function toDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthGrid(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(toDayKey(new Date(year, month, day)));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatMonth(year: number, month: number): string {
  return `${year}. ${String(month + 1).padStart(2, "0")}`;
}

export function CalendarView({ countsByDay, loading, error, onSelectDay }: {
  countsByDay: Map<string, number> | null;
  loading: boolean;
  error: string | null;
  onSelectDay: (date: string) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  const cells = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const maximum = useMemo(() => countsByDay ? Math.max(0, ...countsByDay.values()) : 0, [countsByDay]);
  const monthTotal = useMemo(
    () => cells.reduce((sum, key) => sum + (key ? countsByDay?.get(key) ?? 0 : 0), 0),
    [cells, countsByDay],
  );

  if (error) return <EmptyState title={error} />;
  if (loading || countsByDay === null) return <Skeleton className="calendar-view__skeleton" label="수집 기록을 불러오는 중" />;

  const shiftMonth = (delta: number) => {
    setCursor((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  return <div className="calendar-view" aria-label="수집 달력">
    <header className="calendar-view__header">
      <Button size="icon" variant="ghost" aria-label="이전 달" onClick={() => shiftMonth(-1)}>‹</Button>
      <h3>{formatMonth(cursor.year, cursor.month)} · {monthTotal.toLocaleString("ko-KR")}개</h3>
      <Button size="icon" variant="ghost" aria-label="다음 달" onClick={() => shiftMonth(1)}>›</Button>
    </header>
    <div className="calendar-view__grid" role="grid" aria-label={`${formatMonth(cursor.year, cursor.month)} 수집 기록`}>
      {WEEKDAY_LABELS.map((label) => <span key={label} className="calendar-view__weekday">{label}</span>)}
      {cells.map((key, index) => {
        if (key === null) return <span key={`empty-${index}`} />;
        const count = countsByDay.get(key) ?? 0;
        const intensity = count === 0 ? 0 : Math.min(1, Math.log2(count + 1) / Math.log2(maximum + 1));
        return <button
          key={key}
          type="button"
          className={`calendar-view__day${count === 0 ? " calendar-view__day--empty" : ""}`}
          style={count === 0 ? undefined : { background: `color-mix(in srgb, var(--color-accent) ${Math.round(intensity * 60)}%, transparent)` }}
          aria-label={`${key} 수집 ${count}개`}
          onClick={() => onSelectDay(key)}
        >
          <span>{Number(key.slice(-2))}</span>
          {count > 0 && <span className="calendar-view__day-count">{count > 99 ? "99+" : count}</span>}
        </button>;
      })}
    </div>
  </div>;
}