/** Shared video duration buckets; lower bounds are inclusive, upper bounds exclusive. */
export type AssetDurationFilter = 'all' | 'under_30s' | '30s_1m' | '1m_5m' | 'over_5m';
export const DURATION_LABELS: Record<AssetDurationFilter, string> = {
  all: '전체', under_30s: '30초 미만', '30s_1m': '30초–1분', '1m_5m': '1–5분', over_5m: '5분 이상',
};
export const DURATION_BOUNDS: Record<AssetDurationFilter, { min?: number; max?: number }> = {
  all: {}, under_30s: { max: 30_000 }, '30s_1m': { min: 30_000, max: 60_000 },
  '1m_5m': { min: 60_000, max: 300_000 }, over_5m: { min: 300_000 },
};
export const DURATION_OPTIONS = Object.entries(DURATION_LABELS).map(([value, label]) => ({ value: value as AssetDurationFilter, label }));
export function isAssetDurationFilter(value: unknown): value is AssetDurationFilter {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DURATION_LABELS, value);
}
