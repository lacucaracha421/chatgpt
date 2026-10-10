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

/**
 * Sort values of the ordinary tablet library endpoint. `newest` and `oldest` are the
 * original pair; `favorites` (liked first, then newest) and `random` (a seeded shuffle) are
 * offered only by a server that declares `listVersion` 2 (see `LIST_VERSION_RANKED`).
 */
export type AssetSort = 'newest' | 'oldest' | 'favorites' | 'random';
/**
 * The query-shaping extras that ride on the filter object beside the media/aspect/duration
 * contract: the sort, the shuffle's seed, and the folder subtree mode. They are part of the
 * request, so they are part of `filterKey` and therefore of every cache and cursor identity.
 */
export type AssetQueryFilters = AssetFiltersValue & {sort?: AssetSort; seed?: string; subtree?: boolean};
/** The classification list version that serves the extra sorts, `subtree` and subtree counts. */
export const LIST_VERSION_RANKED = 2;

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
/** 종류 as the section bar's options (전체 · 이미지 · 영상). */
export const MEDIA_SECTIONS = (Object.keys(MEDIA_LABELS) as AssetMediaFilter[]).map(value => ({value, label:MEDIA_LABELS[value]}));
export const ASPECT_LABELS: Record<AssetAspectFilter, string> = {all:'전체', square:'정사각형', landscape:'가로형', portrait:'세로형'};
/** Duration buckets, in ascending order. `over_5m` is left open above its minimum. */
export const DURATION_LABELS: Record<AssetDurationFilter, string> = {
  all:'전체', under_30s:'30초 미만', '30s_1m':'30초–1분', '1m_5m':'1–5분', over_5m:'5분 이상',
};
export const SORT_LABELS: Record<AssetSort, string> = {newest:'최신순',oldest:'오래된순',favorites:'좋아요순',random:'랜덤'};
export const ASSET_SORTS: readonly AssetSort[] = ['newest','oldest'];
/** Every sort, for a server that declares `LIST_VERSION_RANKED`. */
export const RANKED_ASSET_SORTS: readonly AssetSort[] = ['newest','oldest','favorites','random'];

const SEED_PATTERN = /^[0-9A-Za-z]{8,64}$/;
/** A fresh shuffle seed: 32 hex characters, the shape the server accepts. */
export function newSeed(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
/**
 * `random` without a usable seed cannot be requested, so it reads as `newest`: a filter object
 * can never describe a shuffle the wire would refuse.
 */
export function sortOf(filters: AssetFiltersValue): AssetSort {
  const {sort, seed} = filters as AssetQueryFilters;
  if (sort === 'oldest' || sort === 'favorites') return sort;
  return sort === 'random' && typeof seed === 'string' && SEED_PATTERN.test(seed) ? 'random' : 'newest';
}
export function seedOf(filters: AssetFiltersValue): string | undefined {
  return sortOf(filters) === 'random' ? (filters as AssetQueryFilters).seed : undefined;
}
export function subtreeOf(filters: AssetFiltersValue): boolean {
  return (filters as AssetQueryFilters).subtree === true;
}
/** Favorites and random have no date order, so no month index and no date headings. */
export function isRankedSort(sort: AssetSort): boolean {
  return sort === 'favorites' || sort === 'random';
}
/** The same filters under another sort; `random` always carries a seed, every other sort none. */
export function withSort(filters: AssetFiltersValue, sort: AssetSort, seed: string = newSeed()): AssetFiltersValue {
  const {seed: _seed, sort: _sort, ...rest} = filters as AssetQueryFilters;
  void _seed; void _sort;
  return {...rest, sort, ...(sort === 'random' ? {seed} : {})} as AssetFiltersValue;
}
/** The same filters with the folder subtree mode on or off (absent means direct). */
export function withSubtree(filters: AssetFiltersValue, subtree: boolean): AssetFiltersValue {
  const {subtree: _subtree, ...rest} = filters as AssetQueryFilters;
  void _subtree;
  return (subtree ? {...rest, subtree: true} : rest) as AssetFiltersValue;
}
/** Only the sort, seed and subtree extras of a filter object, for carrying across a reset. */
export function queryExtras(filters: AssetFiltersValue): Partial<AssetQueryFilters> {
  const {sort, seed, subtree} = filters as AssetQueryFilters;
  return {...(sort ? {sort} : {}), ...(seed ? {seed} : {}), ...(subtree ? {subtree} : {})};
}

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
  // newest is the endpoint default; only the non-default value needs a wire parameter.
  const sort = sortOf(filters);
  if (sort !== 'newest') params.set('sort', sort);
  if (sort === 'random') params.set('seed', seedOf(filters)!);
  if (subtreeOf(filters)) params.set('subtree', '1');
  return params;
}
/** Append the active filters to an already-built path. No filters leaves the path untouched. */
export function withFilters(path: string, filters: AssetFiltersValue) {
  const params = filterParams(filters);
  if (![...params].length) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${params}`;
}

/**
 * Refuse a page that was not answered under the sort and scope it was asked for.
 *
 * A server that predates the extra sorts or the subtree mode ignores (or rejects) the
 * parameters, and presenting its direct, date-ordered page as a shuffle or a subtree would be
 * a wrong list under a right-looking title. `searchFilters` echoes what the server applied.
 */
export function assertAppliedQuery(reply: unknown, filters: AssetFiltersValue): void {
  const sort = sortOf(filters), subtree = subtreeOf(filters);
  if (!subtree && (sort === 'newest' || sort === 'oldest')) return;
  const applied = (reply as {searchFilters?: {sort?: unknown; subtree?: unknown}} | null | undefined)?.searchFilters;
  if (subtree && applied?.subtree !== 1) throw new Error('이 서버는 하위 폴더까지 보기를 지원하지 않습니다. 서버를 업데이트해 주세요.');
  if (isRankedSort(sort) && applied?.sort !== sort) throw new Error('이 서버는 이 정렬을 지원하지 않습니다. 서버를 업데이트해 주세요.');
}
