export interface Asset {
  id: string; kind: string; content_type?: string; size_bytes?: number;
  width?: number | null; height?: number | null; collected_at?: string;
  created_at?: string; source_url?: string; creator_name?: string; creator_handle?: string;
  // Server-backed fields the mobile asset projection already sends. `duration_ms` is only
  // meaningful for video; `source_published_at` is the post time, not the import time, and
  // is kept distinct from `collected_at` rather than being inferred from it.
  duration_ms?: number | null; source_published_at?: string | null;
  classification_ids?: string[]; thumbnail_available?: boolean;
  pending?: boolean; preview?: string; ratio?: number;
}
export interface Classification { id: string; name: string; parent_id: string | null; asset_count: number; color_key?: string; icon_key?: string }
export interface Page { items: Asset[]; has_more: boolean; next_cursor: string | null }
export interface View { characterNode?:string; characters?: boolean; tab: 'home' | 'library'; classification?: string; revisit?: 'date' | string; title: string }
export interface Ticket { url: string; expires_at?: string; expires_in?: number; content_type?: string }
export interface Status { configured: boolean; endpoint: string; allowPrivateHttp?: boolean }
export interface Revisit { bundles: {kind: string; title: string; items?: Asset[]; groups?: {creator_key: string; creator_name: string; creator_handle: string; asset_count: number; items: Asset[]}[]}[] }
export interface SavedPosition { view: View; cursor: string | null; previous: (string | null)[]; scroll: number; assetId?: string }
