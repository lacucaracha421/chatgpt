/**
 * Connecting a manga Collection to MangaDex / Kakao from the tablet (server
 * `collection_bindings.py`, 2026-09-26). The server searches, so the tablet can pick while the
 * PC is off; the tablet files a bind request and the PC applies it when it next runs.
 *
 * The connection itself is derived from the published Collection: `releaseSchedule.kakao` /
 * `.mangadex` is non-null exactly when the PC holds that binding (an upgraded PC publishes
 * `releaseSchedule`), and `releaseWatch.available` says an Aladin/Kakao binding exists.
 */
import {ApiError, api, errorText} from './transport';
import type {CollectionDetail} from './collectionModel';

export type BindProvider = 'mangadex' | 'kakao';
export const PROVIDER_NAMES: Record<BindProvider, string> = {mangadex: 'MangaDex', kakao: '카카오'};

export const BINDINGS_PREFIX = '/v1/collections/bindings';
export const BINDINGS_STATUS_PATH = `${BINDINGS_PREFIX}/status`;
export const BIND_REQUESTS_PATH = `${BINDINGS_PREFIX}/requests`;
export const searchPath = (provider: BindProvider, query: string) => `${BINDINGS_PREFIX}/search/${provider}?${new URLSearchParams({query})}`;
export const requestsPath = (collectionId: string) => `${BIND_REQUESTS_PATH}?${new URLSearchParams({collectionId, state: 'all', limit: '20'})}`;

export type BindStatus = {version: 1; mangadexSearch: boolean; kakaoSearch: boolean; bindRequests: boolean; publisherSeenAt: string | null};
export type MangaDexCandidate = {mangaId: string; title: string; alternateTitles: string[]; author: string | null; year: number | null; status: string | null; primaryCoverFileName?: string | null; coverUrl: string | null};
export type KakaoCandidate = {
  anchorItemId: string; groupFingerprint: string; title: string; author: string | null; publisher: string | null;
  volumes: {volumeNumber: number; providerItemId: string; title: string; publicationDate: string | null; isbn13: string | null}[];
  ignoredCount: number; volumeCount: number; firstVolume: number | null; lastVolume: number | null; knownItemIds: string[]; thumbnailUrl: string | null;
};
export type SearchReply<T> = {version: 1; provider: BindProvider; query: string; items: T[]};
export type BindRequest = {
  requestId: number; operationId: string; collectionId: string; provider: BindProvider; choice: Record<string, unknown>;
  expected: {externalId: string | null} | null; state: 'pending' | 'applied' | 'failed' | 'superseded';
  reason: {code: string; message: string} | null; replaces: number | null; createdAt: string; updatedAt: string; resolvedAt: string | null;
};
export type RequestsReply = {version: 1; items: BindRequest[]; pending: Record<BindProvider, BindRequest | null> | null};
export type MangaDexChoice = {mangaId: string; title: string; coverUrl: string | null};
export type KakaoChoice = {query: string; anchorItemId: string; groupFingerprint: string; title: string; author: string | null; publisher: string | null; volumeCount: number | null; thumbnailUrl: string | null};
export type BindCommand = {version: 1; operationId: string; collectionId: string; provider: BindProvider; choice: MangaDexChoice | KakaoChoice; expected?: {externalId: null}};

/**
 * What the published Collection says about one provider. `aladin`: only the retired Aladin
 * binding (the PC asks to reconnect with Kakao). `unknown`: the PC has not published enough to tell.
 */
export type Connection = 'connected' | 'unbound' | 'aladin' | 'unknown';
export function connectionOf(item: CollectionDetail, provider: BindProvider): Connection {
  const schedule = item.releaseSchedule;
  if (schedule) {
    if (schedule[provider] != null) return 'connected';
    return provider === 'kakao' && item.releaseWatch?.available ? 'aladin' : 'unbound';
  }
  if (provider === 'kakao' && item.releaseWatch) return item.releaseWatch.available ? 'connected' : 'unbound';
  return 'unknown';
}

/** The latest meaningful request per provider: pending first, else the newest resolved one. */
export function latestRequest(reply: RequestsReply | null, provider: BindProvider): BindRequest | null {
  if (!reply) return null;
  const pending = reply.pending?.[provider] ?? reply.items.find(entry => entry.provider === provider && entry.state === 'pending');
  if (pending) return pending;
  return reply.items.find(entry => entry.provider === provider && entry.state !== 'superseded') ?? null;
}

export const chosenTitle = (request: BindRequest) => typeof request.choice.title === 'string' ? request.choice.title : '';

/** A MangaDex publication status in Korean; anything unknown is shown as it came. */
export function mangaDexStatus(status: string | null) {
  if (!status) return '';
  return ({ongoing: '연재 중', completed: '완결', hiatus: '휴재', cancelled: '연재 중단'} as Record<string, string>)[status] ?? status;
}
/** A Kakao group's volumes as `1–12권`, with the count when volumes are missing in between. */
export function kakaoVolumes(candidate: KakaoCandidate) {
  const {firstVolume: first, lastVolume: last, volumeCount: count} = candidate;
  if (first == null || last == null) return count > 0 ? `${count}권` : '';
  const range = first === last ? `${first}권` : `${first}–${last}권`;
  return count > 0 && count !== last - first + 1 ? `${range} · ${count}권` : range;
}
/** External cover/thumbnail URLs are shown only when https (data: art only in the dev preview). */
export const safeImageUrl = (url: string | null | undefined) => !!url && (/^https:\/\/[^\s]+$/.test(url) || (import.meta.env.DEV && url.startsWith('data:image/'))) ? url : null;

export function mangaDexCommand(collectionId: string, operationId: string, candidate: MangaDexCandidate, connection: Connection): BindCommand {
  return {version: 1, operationId, collectionId, provider: 'mangadex',
    choice: {mangaId: candidate.mangaId, title: candidate.title.slice(0, 500), coverUrl: candidate.coverUrl ?? null},
    ...(connection === 'unbound' ? {expected: {externalId: null}} : {})};
}
/** `query` is the server's normalized query, as the PC re-runs exactly that search. */
export function kakaoCommand(collectionId: string, operationId: string, query: string, candidate: KakaoCandidate, connection: Connection): BindCommand {
  return {version: 1, operationId, collectionId, provider: 'kakao',
    choice: {query, anchorItemId: candidate.anchorItemId, groupFingerprint: candidate.groupFingerprint, title: candidate.title.slice(0, 500),
      author: candidate.author ?? null, publisher: candidate.publisher ?? null, volumeCount: candidate.volumeCount ?? null, thumbnailUrl: candidate.thumbnailUrl ?? null},
    ...(connection === 'unbound' ? {expected: {externalId: null}} : {})};
}
export const fileBindRequest = (command: BindCommand, signal?: AbortSignal) => api<{version: 1; request: BindRequest}>(BIND_REQUESTS_PATH, signal, command, 'POST');

export type BindFailure = {text: string; retry: boolean; waitSeconds?: number};
const detailOf = (error: unknown) => {
  const detail = error instanceof ApiError ? (error.details as {detail?: unknown} | null)?.detail : null;
  return detail && typeof detail === 'object' ? detail as {code?: unknown; message?: unknown; retryAfter?: unknown} : null;
};
/** A server message is shown only when it is short plain text (the server writes them in Korean). */
const serverMessage = (message: unknown) => typeof message === 'string' && message.length > 0 && message.length <= 180 && !/https?:|bearer|token=/i.test(message) ? message : '';
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** What a failed search says, whether a retry can help and, when rate limited, how long to wait. */
export function searchFailure(error: unknown, provider: BindProvider): BindFailure {
  const name = PROVIDER_NAMES[provider];
  const detail = detailOf(error), code = typeof detail?.code === 'string' ? detail.code : '';
  switch (code) {
    case 'kakaoSearchUnavailable': return {text: '서버에 카카오 키가 없어 검색할 수 없어요.', retry: false};
    case 'kakaoCredentialRejected': return {text: '서버의 카카오 키가 거부됐어요. 서버 설정을 확인해 주세요.', retry: false};
    case 'kakaoSearchTooBroad': return {text: '검색 결과가 너무 많아요. 검색어를 더 구체적으로 적어 주세요.', retry: false};
    case 'invalidBindSearch': return {text: '검색어를 두 글자 이상 100자 이하로 적어 주세요.', retry: false};
    case 'bindSearchRateLimited': {
      const seconds = typeof detail?.retryAfter === 'number' && detail.retryAfter > 0 ? Math.min(600, Math.ceil(detail.retryAfter)) : 10;
      return {text: '검색을 너무 자주 했어요.', retry: true, waitSeconds: seconds};
    }
    case 'bindSearchUpstreamRateLimited': return {text: `${name}에서 요청을 잠시 막았어요. 조금 뒤 다시 시도해 주세요.`, retry: true};
    case 'bindSearchTimedOut': return {text: `${name} 응답이 늦어요. 다시 시도해 주세요.`, retry: true};
    case 'bindSearchUpstreamFailed': case 'bindSearchInvalidResponse': return {text: `${name}에서 검색하지 못했어요. 다시 시도해 주세요.`, retry: true};
  }
  if (error instanceof ApiError && error.status === 404 && !code) return {text: '서버를 업데이트해야 여기서 연결할 수 있어요.', retry: false};
  if (offline()) return {text: '오프라인이에요. 네트워크를 확인한 뒤 다시 시도해 주세요.', retry: true};
  return {text: errorText(error) || `${name}에서 검색하지 못했어요.`, retry: true};
}
/** What a failed bind request says; the server's own Korean message where it has one. */
export function requestFailure(error: unknown): BindFailure {
  const detail = detailOf(error), code = typeof detail?.code === 'string' ? detail.code : '';
  if (code === 'collectionNotFound') return {text: '이 작품을 서버에서 찾지 못했어요. 새로고침한 뒤 다시 시도해 주세요.', retry: false};
  if (code === 'collectionNotManga') return {text: '만화 작품만 연결할 수 있어요.', retry: false};
  if (code === 'bindRequestLimit') return {text: 'PC가 아직 적용하지 않은 연결 요청이 너무 많아요. PC를 켠 뒤 다시 시도해 주세요.', retry: false};
  if (code) return {text: serverMessage(detail?.message) || '연결 요청을 보내지 못했어요.', retry: code !== 'invalidBindRequest' && code !== 'bindRequestTooLarge' && code !== 'operationConflict'};
  if (error instanceof ApiError && error.status === 404) return {text: '서버를 업데이트해야 여기서 연결할 수 있어요.', retry: false};
  if (offline()) return {text: '오프라인이에요. 네트워크를 확인한 뒤 다시 시도해 주세요.', retry: true};
  return {text: errorText(error) || '연결 요청을 보내지 못했어요.', retry: true};
}
