export interface Asset {
  id: string; kind: string; content_type?: string; size_bytes?: number;
  width?: number | null; height?: number | null; collected_at?: string;
  created_at?: string; source_url?: string; creator_name?: string; creator_handle?: string;
  // Server-backed fields the mobile asset projection already sends. `duration_ms` is only
  // meaningful for video; `source_published_at` is the post time, not the import time, and
  // is kept distinct from `collected_at` rather than being inferred from it.
  duration_ms?: number | null; source_published_at?: string | null;
  classification_ids?: string[]; thumbnail_available?: boolean;
  // An opaque token that changes whenever the Asset's thumbnail object changes. Native keys
  // its disk cache and local URL by it, so a regenerated thumbnail is not served from the
  // retained old copy. Absent from servers that do not send it (then the cache keys by id).
  thumbnail_revision?: string | null;
  pending?: boolean; preview?: string; ratio?: number;
}
export interface Classification { id: string; name: string; parent_id: string | null; asset_count: number; color_key?: string; icon_key?: string }
/**
 * A page as it arrives on the wire.
 *
 * The routes disagree on envelope case (`has_more`/`next_cursor` beside `filterVersion`),
 * so the untranslated shape is named once here. `normalizePage` is the only reader, and it
 * resolves the filter contract through `assetFilters.filterVersionOf`, the single agreed
 * wire name — this type deliberately declares no alternative spelling of it.
 */
export interface PageWire { items: Asset[]; has_more: boolean; next_cursor: string | null; filterVersion?: unknown }
/**
 * A normalized page: one spelling every caller can rely on.
 *
 * `filter_version` is absent when the server did not declare exactly the contract this
 * client implements. That absence is meaningful rather than defaulted: a server that cannot
 * promise the contract cannot have applied the parameters, so a filtered request must be
 * refused instead of presented as filtered.
 */
export interface Page { items: Asset[]; has_more: boolean; next_cursor: string | null; filter_version?: number;
  /** The list generation the server read these rows under; absent from servers that predate it. */
  list_generation?: string }
/**
 * Asset filters, mirroring the PC's media/aspect vocabulary. `all` is the client-side
 * spelling of "no filter" and is never sent on the wire.
 */
export type AssetMediaFilter = 'all' | 'images' | 'videos';
export type AssetAspectFilter = 'all' | 'square' | 'landscape' | 'portrait';
export type AssetDurationFilter = 'all' | 'under_30s' | '30s_1m' | '1m_5m' | 'over_5m';
export interface AssetFiltersValue { media: AssetMediaFilter; aspect: AssetAspectFilter; duration: AssetDurationFilter }
export interface View { album?:{id:string;libraryId:string;epoch:number}; root?:boolean; characterNode?:string; characters?: boolean; tab: 'home' | 'library'; classification?: string; revisit?: 'date' | string; title: string }
export interface Ticket { url: string; expires_at?: string; expires_in?: number; content_type?: string }
export interface Status { configured: boolean; endpoint: string; allowPrivateHttp?: boolean }
export interface Revisit { bundles: {kind: string; title: string; items?: Asset[]; groups?: {creator_key: string; creator_name: string; creator_handle: string; asset_count: number; items: Asset[]}[]}[] }
export interface SavedPosition { view: View; cursor: string | null; previous: (string | null)[]; scroll: number; assetId?: string; filters: AssetFiltersValue }
