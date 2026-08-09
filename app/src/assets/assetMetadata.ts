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
