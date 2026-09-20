/**
 * One Asset filter vocabulary shared by every mobile gallery scope.
 *
 * PC owns the bucket boundaries (`query.rs`): `images` includes `gif`, and the aspect
 * arithmetic is an inclusive 0.8–1.25 band for square. The wire strings below mirror the
 * PC's exactly, so the ordinary library, Album and Character scopes cannot drift from each
 * other or from the desktop.
 *
 * Duration is new: PC has no duration filter, so these labels name their own buckets
 * rather than mirroring a desktop control that does not exist.
 */
import type {AssetFiltersValue, AssetMediaFilter, AssetAspectFilter, AssetDurationFilter} from './types';

export const EMPTY_FILTERS: AssetFiltersValue = {media:'all', aspect:'all', duration:'all'};

/** The only Asset filter contract this client understands. */
export const ASSET_FILTER_VERSION = 1;

/**
 * The Asset filter contract version a reply declares, or `null` when it does not declare
 * exactly the version this client implements.
 *
 * `filterVersion` is the agreed wire name and this is the single normalization point: every
 * reader of a page or capability reply goes through here, so no caller has to know the
 * spelling. The snake_case variant is deliberately *not* accepted — guessing an unagreed
 * spelling would defeat the guard it feeds, which exists to stop an unfiltered list being
 * presented as a filtered one. An unknown version is refused for the same reason: a server
 * that applied a contract this client cannot interpret is not safe to display as filtered.
 */
export function filterVersionOf(reply: unknown): number | null {
  if (typeof reply !== 'object' || reply === null) return null;
  const value = (reply as Record<string, unknown>).filterVersion;
  return value === ASSET_FILTER_VERSION ? ASSET_FILTER_VERSION : null;
}

export const MEDIA_LABELS: Record<AssetMediaFilter, string> = {all:'전체', images:'이미지', videos:'영상'};
export const ASPECT_LABELS: Record<AssetAspectFilter, string> = {all:'전체', square:'정사각형', landscape:'가로형', portrait:'세로형'};
/** Duration buckets, in ascending order. `over_5m` is left open above its minimum. */
export const DURATION_LABELS: Record<AssetDurationFilter, string> = {
  all:'전체', under_30s:'30초 미만', '30s_1m':'30초–1분', '1m_5m':'1–5분', over_5m:'5분 이상',
};

/** Inclusive/exclusive millisecond bounds. Absent means unbounded, never `0`. */
const DURATION_BOUNDS: Record<AssetDurationFilter, {min?:number; max?:number}> = {
  all:{}, under_30s:{max:30_000}, '30s_1m':{min:30_000, max:60_000}, '1m_5m':{min:60_000, max:300_000}, over_5m:{min:300_000},
};

export function sameFilters(left: AssetFiltersValue, right: AssetFiltersValue) {
  return left.media === right.media && left.aspect === right.aspect && left.duration === right.duration;
}
export function hasActiveFilters(filters: AssetFiltersValue) {
  return !sameFilters(filters, EMPTY_FILTERS);
}
/**
 * Canonical, order-stable serialization of exactly the parameters the request carries.
 *
 * This is the cache, prefetch and navigation identity, so it is derived from the same
 * fields that go on the wire rather than from the filter object's shape. It must stay
 * independent of the loaded items: an identity that grew with every appended page would
 * change on each append and reset the gallery's scroll anchor.
 */
export function filterKey(filters: AssetFiltersValue) {
  return filterParams(filters).toString();
}
/**
 * The wire parameters for one filter set, empty when nothing is filtered.
 *
 * An absent parameter means "no filter", matching how `classification_id` already behaves,
 * so an untouched control sends nothing and the request stays byte-identical to the
 * pre-filter contract.
 */
export function filterParams(filters: AssetFiltersValue) {
  const params = new URLSearchParams();
  if (filters.media !== 'all') params.set('media_kind', filters.media);
  if (filters.aspect !== 'all') params.set('aspect_ratio', filters.aspect);
  const bounds = DURATION_BOUNDS[filters.duration] ?? {};
  if (bounds.min !== undefined) params.set('duration_ms_min', String(bounds.min));
  if (bounds.max !== undefined) params.set('duration_ms_max', String(bounds.max));
  return params;
}
/** Append the active filters to an already-built path. No filters leaves the path untouched. */
export function withFilters(path: string, filters: AssetFiltersValue) {
  const params = filterParams(filters);
  if (![...params].length) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${params}`;
}
