import {api, native} from './transport';
import {outboxConnection} from './outboxConnection';
import {sameAuthority, type AuthorityIdentity, type ArtworkReply, type BlobReceipt, type Fields, type Provider, type WorkCommand} from './collectionCommandOutbox';
import type {CollectionDetail} from './collectionModel';

export type ProviderStatus = Record<Provider, boolean>;
export type ProviderCandidate = {externalId: string; name: string; originalTitle?: string | null; year: number | null; previewUrl: string | null};
export type ArtworkCandidate = {kind: string; path: string; previewUrl: string; width: number | null; height: number | null; seasonNumber?: number};
export type ProviderDetail = {binding: {provider: Provider; externalId: string}; metadata: Fields & {name: string}; artwork: ArtworkCandidate[]};
export type ArtworkChoice = 'keep' | 'clear' | ArtworkCandidate;
export const providerName = (provider: Provider) => provider.toUpperCase();
export const providerFor = (type: string): Provider | null => type === 'movie' ? 'tmdb' : type === 'game' ? 'igdb' : null;
export const artworkLabel = (provider: Provider) => provider === 'tmdb' ? '포스터·배경 변경' : '표지·hero 변경';
export function providerSearchPath(provider: Provider, query: string, kind: 'movie' | 'tv') {
  const params = new URLSearchParams({query}); if (provider === 'tmdb') params.set('kind', kind);
  return `/v1/providers/${provider}/search?${params}`;
}
export function providerDetailPath(provider: Provider, externalId: string) {
  if (!/^(?:tv:)?[1-9][0-9]*$/.test(externalId) || provider === 'igdb' && externalId.startsWith('tv:')) throw new Error('작품 ID를 확인해 주세요.');
  return provider === 'igdb' ? `/v1/providers/igdb/${externalId}`
    : `/v1/providers/tmdb/${externalId.startsWith('tv:') ? 'tv' : 'movie'}/${externalId.replace(/^tv:/, '')}`;
}
/** Relative provider previews always travel through the authenticated API base, never provider hosts. */
export function providerImagePath(value: string | null): string | null {
  if (!value?.startsWith('/v1/providers/image?') || value.includes('#') || value.includes('\\')) return null;
  const params = new URLSearchParams(value.slice(value.indexOf('?') + 1));
  const provider = params.get('provider'), size = params.get('size');
  return (provider === 'tmdb' && ['w185', 'w342', 'w780'].includes(size ?? '')
    || provider === 'igdb' && ['t_cover_big', 't_screenshot_med', 't_720p', 't_1080p'].includes(size ?? '')) && params.has('path') ? value : null;
}
// Native image lanes hold 8 running + 48 queued requests and refuse the rest, so a sheet
// with many candidates (55 posters + backdrops + season posters) must not send them all at once.
const PREVIEW_SLOTS = 6;
let previewsRunning = 0;
const previewQueue: (() => void)[] = [];
function nextPreview() { previewsRunning--; previewQueue.shift()?.(); }
export function providerPreview(value: string | null, signal: AbortSignal) {
  const path = providerImagePath(value), connection = outboxConnection();
  if (!path || !connection) return Promise.resolve<{url: string} | null>(null);
  return new Promise<{url: string} | null>((resolve, reject) => {
    const start = () => {
      if (signal.aborted) { nextPreview(); reject(new DOMException('Aborted', 'AbortError')); return; }
      native<{url: string}>('providerImage', {path, connection}, signal).then(resolve, reject).finally(nextPreview);
    };
    const queued = () => { previewsRunning++; start(); };
    if (previewsRunning < PREVIEW_SLOTS) { queued(); return; }
    previewQueue.push(queued);
    signal.addEventListener('abort', () => {
      const index = previewQueue.indexOf(queued);
      if (index >= 0) { previewQueue.splice(index, 1); reject(new DOMException('Aborted', 'AbortError')); }
    }, {once: true});
  });
}
/** The existing read projection omits bindings. Read only that baseline section, with its frozen cursor. */
export async function readProviderBinding(identity: AuthorityIdentity, workId: string, provider: Provider, signal: AbortSignal) {
  const connection = outboxConnection();
  if (!connection) throw new Error('서버 연결을 확인해 주세요.');
  const params = new URLSearchParams({libraryId: identity.libraryId, epoch: String(identity.epoch)});
  const base = '/v1/collections/authority/baseline';
  const manifest = await api<AuthorityIdentity & {snapshotCursor: number}>(`${base}?${params}`, signal, undefined, 'GET', false, connection);
  if (!sameAuthority(manifest, identity)) throw new Error('라이브러리가 변경되었습니다. 다시 열어 주세요.');
  params.set('snapshot', String(manifest.snapshotCursor)); params.set('section', 'bindings');
  let after: string | null = null;
  do {
    if (after) params.set('after', after);
    const page = await api<AuthorityIdentity & {items: {workId: string; provider: string; bound: boolean; externalId: string}[]; hasMore: boolean; nextAfter: string | null}>(`${base}?${params}`, signal, undefined, 'GET', false, connection);
    if (!sameAuthority(page, identity) || connection !== outboxConnection()) throw new Error('라이브러리가 변경되었습니다. 다시 열어 주세요.');
    const binding = page.items.find(row => row.workId === workId && row.provider === provider && row.bound);
    if (binding) return binding.externalId;
    after = page.hasMore ? page.nextAfter : null;
    if (page.hasMore && !after) throw new Error('연결 정보를 확인하지 못했습니다.');
  } while (after);
  return null;
}
/** The relay's thumbnail when it is a well-formed WebP receipt; the shelf falls back to the original otherwise. */
function validThumbnail(blob: BlobReceipt | null | undefined): BlobReceipt | null {
  return blob && /^[a-f0-9]{64}$/.test(blob.sha256) && Number.isSafeInteger(blob.sizeBytes) && blob.sizeBytes > 0 && blob.contentType === 'image/webp'
    ? {sha256: blob.sha256, sizeBytes: blob.sizeBytes, contentType: blob.contentType} : null;
}
export async function artworkCommands(item: CollectionDetail, provider: Provider, choices: Record<string, ArtworkChoice>, signal?: AbortSignal): Promise<WorkCommand[]> {
  const connection = outboxConnection();
  if (!connection) throw new Error('서버 연결을 확인해 주세요.');
  const commands: WorkCommand[] = [];
  for (const slot of ['work', provider === 'tmdb' ? 'backdrop' : 'hero'] as const) {
    const choice = choices[slot] ?? 'keep'; if (choice === 'keep') continue;
    const expectedArtworkId = (slot === 'work' ? item.selectedWorkArtworkId : slot === 'hero' ? item.selectedHeroArtworkId : item.selectedBackdropArtworkId) ?? null;
    let artworkId: string | null = null;
    if (choice !== 'clear') {
      const receipt = await api<ArtworkReply>('/v1/providers/artwork', signal, {provider, path: choice.path, size: 'original'}, 'POST', false, connection);
      if (connection !== outboxConnection() || receipt.provider !== provider || receipt.providerImageId !== choice.path
        || !/^[a-f0-9]{64}$/.test(receipt.original?.sha256 ?? '') || !Number.isSafeInteger(receipt.original.sizeBytes)
        || receipt.original.sizeBytes <= 0 || !Number.isSafeInteger(receipt.width) || receipt.width <= 0 || !Number.isSafeInteger(receipt.height) || receipt.height <= 0)
        throw new Error('저장된 이미지를 확인하지 못했습니다.');
      artworkId = crypto.randomUUID();
      commands.push({commandType: 'addArtwork', workId: item.id, artworkId, kind: slot === 'work' ? 'cover' : slot,
        provider: receipt.provider, providerImageId: receipt.providerImageId, original: receipt.original,
        width: receipt.width, height: receipt.height, language: null, thumbnail: validThumbnail(receipt.thumbnail)});
    }
    commands.push({commandType: 'selectArtwork', workId: item.id, slot, artworkId, expectedArtworkId});
  }
  return commands;
}
