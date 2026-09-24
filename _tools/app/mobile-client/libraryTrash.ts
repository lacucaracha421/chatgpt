import {api, native} from './transport';
import type {Asset} from './types';

/**
 * Mobile Library Trash: the web side of the native lifecycle outbox.
 *
 * The native layer owns the durable intents and every protocol field (operation id, library,
 * epoch, expected revision). The web supplies an Asset id, `trash` or `restore`, and the
 * lifecycle revision it saw in the trash list. There is deliberately no empty operation:
 * emptying the trash is a PC action.
 */
export type LifecycleCommand = 'trash' | 'restore';
export type LifecycleRowState = 'pending' | 'sending' | 'blocked' | 'dropped';
export type LifecycleRow = {assetId: string; command: LifecycleCommand; state: LifecycleRowState; conflictCode: string | null; createdAt: string};
export type LifecycleState = {available: boolean; code?: string; items: LifecycleRow[]; cancelled?: boolean; tombstoned?: boolean};
export type TrashItem = Asset & {lifecycle: 'trash'; entityRevision: number; trashedAt: string};
export type TrashPage = {active: boolean; items: TrashItem[]; next_cursor: string | null; has_more: boolean; total_count: number; total_bytes: number};

/** Fired after every local lifecycle edit, with the new native state as detail. */
export const ASSET_LIFECYCLE_EVENT = 'lakomics-asset-lifecycle';
export const TRASH_PAGE = 60;

const EMPTY: LifecycleState = {available: false, items: []};

function valid(state: unknown): state is LifecycleState {
  const value = state as LifecycleState | null;
  return !!value && typeof value.available === 'boolean' && Array.isArray(value.items);
}

export async function readLifecycle(signal?: AbortSignal): Promise<LifecycleState> {
  const state = await native<LifecycleState>('assetLifecycleState', {}, signal);
  return valid(state) ? state : EMPTY;
}

export async function setLifecycle(assetId: string, command: LifecycleCommand, seenRevision = 0): Promise<LifecycleState> {
  const state = await native<LifecycleState>('assetLifecycleSet', {assetId, command, seenRevision});
  const result = valid(state) ? state : EMPTY;
  window.dispatchEvent(new CustomEvent(ASSET_LIFECYCLE_EVENT, {detail: result}));
  return result;
}

export async function dismissLifecycle(assetId: string): Promise<LifecycleState> {
  const state = await native<LifecycleState>('assetLifecycleDismiss', {assetId});
  const result = valid(state) ? state : EMPTY;
  window.dispatchEvent(new CustomEvent(ASSET_LIFECYCLE_EVENT, {detail: result}));
  return result;
}

/** Assets the library must hide now: trash intents the server has not accepted yet. */
export function pendingTrashIds(state: LifecycleState): string[] {
  return state.items.filter(row => row.command === 'trash' && (row.state === 'pending' || row.state === 'sending')).map(row => row.assetId);
}

export function trashPath(cursor: string | null, limit = TRASH_PAGE) {
  return `/v1/library/trash?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
}

export function readTrash(cursor: string | null, signal?: AbortSignal): Promise<TrashPage> {
  return api<TrashPage>(trashPath(cursor), signal);
}

/**
 * Thumbnail URLs for trashed Assets through the trash-scoped ticket batch.
 *
 * Only `https:` URLs are accepted, exactly like the viewer's ticket check, so a malformed
 * reply can never place another scheme into an image source.
 */
export async function trashThumbnails(ids: string[], signal?: AbortSignal): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const reply = await api<{items: {asset_id: string; ok: boolean; url?: string}[]}>(
    '/v1/library/media-tickets?lifecycle=trash', signal,
    {items: ids.map(asset_id => ({asset_id, variant: 'thumbnail'}))}, 'POST');
  const urls: Record<string, string> = {};
  for (const entry of reply?.items ?? []) {
    if (entry.ok && typeof entry.url === 'string' && /^https:\/\//.test(entry.url)) urls[entry.asset_id] = entry.url;
  }
  return urls;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function trashDate(value: string | undefined): string {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? `${date.getMonth() + 1}월 ${date.getDate()}일` : '';
}

/** One tile of the trash browser: a server trash row, or a local intent the server has not seen. */
export type TrashTile = {
  id: string;
  asset: Asset;
  trashedAt?: string;
  entityRevision: number;
  /** Where this tile is: in the server trash, or held by a local intent. */
  status: 'trash' | 'moving' | 'restoring' | 'conflict' | 'deleted';
  onServer: boolean;
};

export const TILE_LABEL: Record<TrashTile['status'], string> = {
  trash: '',
  moving: '이동 대기',
  restoring: '복원 대기',
  conflict: '충돌',
  deleted: '영구 삭제됨',
};

/**
 * Compose the tiles: local intents first (they are the newest), then the server trash.
 *
 * * a pending trash the server has not accepted → "이동 대기";
 * * a server trash row with a pending restore → "복원 대기";
 * * a blocked intent → "충돌"; a dropped one → "영구 삭제됨";
 * * a server row whose restore was already accepted disappears on the next read.
 */
export function trashTiles(server: TrashItem[], state: LifecycleState, known: ReadonlyMap<string, Asset>): TrashTile[] {
  const latest = new Map<string, LifecycleRow>();
  for (const row of state.items) latest.set(row.assetId, row);
  const onServer = new Set(server.map(item => item.id));
  const local: TrashTile[] = [];
  for (const row of [...latest.values()].reverse()) {
    if (onServer.has(row.assetId)) continue;
    const status: TrashTile['status'] | null = row.state === 'dropped' ? 'deleted' : row.state === 'blocked' ? 'conflict'
      : row.command === 'trash' ? 'moving' : null;
    if (!status) continue;
    local.push({id: row.assetId, asset: known.get(row.assetId) ?? {id: row.assetId, kind: 'image'}, entityRevision: 0,
      trashedAt: row.createdAt, status, onServer: false});
  }
  const rows: TrashTile[] = server.map(item => {
    const row = latest.get(item.id);
    const status: TrashTile['status'] = !row ? 'trash'
      : row.state === 'dropped' ? 'deleted'
      : row.state === 'blocked' ? 'conflict'
      : row.command === 'restore' ? 'restoring' : 'trash';
    return {id: item.id, asset: item, trashedAt: item.trashedAt, entityRevision: item.entityRevision, status, onServer: true};
  });
  return [...local, ...rows];
}
