/** The same quiet duration label on desktop and tablet asset tiles. */
export function formatDuration(durationMs: number | null | undefined) {
  if (durationMs == null || !Number.isFinite(durationMs)) return '—';
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
