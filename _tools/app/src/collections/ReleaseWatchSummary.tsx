import type { ReleaseWatchEvent } from "../library/types";

export function ReleaseWatchSummary({ events }: { events: ReleaseWatchEvent[] }) {
  if (events.length === 0) return null;

  return (
    <section className="release-watch-summary" aria-label="새 출간 정보">
      <strong>새 출간 정보</strong>
      <ul>
        {summaryLines(events).map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
      </ul>
    </section>
  );
}

function summaryLines(events: ReleaseWatchEvent[]) {
  const newVolumes = events
    .filter((event) => event.kind === "new_volume")
    .map((event) => event.volumeNumber)
    .sort((left, right) => left - right);
  const dateChanges = events
    .filter((event) => event.kind === "release_date_changed")
    .map((event) => `출간일 변경: ${event.volumeNumber}권 ${dateValue(event.previousValue)} → ${dateValue(event.currentValue)}`);
  const statusChanges = events
    .filter((event) => event.kind === "release_status_changed")
    .map((event) => `출간 상태 변경: ${event.volumeNumber}권 ${statusValue(event.previousValue)} → ${statusValue(event.currentValue)}`);

  return [
    ...(newVolumes.length > 0 ? [`새 권: ${newVolumes.map((volume) => `${volume}권`).join(", ")}`] : []),
    ...dateChanges,
    ...statusChanges,
  ];
}

function dateValue(value: string | null) {
  return value ?? "알 수 없음";
}

function statusValue(value: string | null) {
  if (value === "upcoming") return "출간 예정";
  if (value === "released") return "출간됨";
  return value ?? "알 수 없음";
}
