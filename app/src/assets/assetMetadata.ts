export function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} KB`;
}

export function sourceLabel(sourceUrl: string | null): string {
  if (!sourceUrl) return "—";
  try {
    const url = new URL(sourceUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return sourceUrl;
  }
}

export function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export function creatorLabel(
  name: string | null,
  handle: string | null,
): string {
  const account = handle ? `@${handle.replace(/^@+/, "")}` : null;
  if (name && account) return `${name} (${account})`;
  return name || account || "—";
}

const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  direct: "직접 추가",
  browser_extension: "브라우저 확장",
  metadata_import: "메타데이터 가져오기",
  legacy_lakomics: "구버전 Lakomics 이전",
};

export function importSourceLabel(value: ImportSource | null): string {
  return value ? IMPORT_SOURCE_LABELS[value] ?? "—" : "—";
}

export function localDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function batchLabel(value: string | null): string {
  if (!value) return "—";
  return value.length > 12 ? value.slice(0, 8) : value;
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteText = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const secondText = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${minuteText}:${secondText}` : `${minuteText}:${secondText}`;
}
import type { ImportSource } from "../library/types";
