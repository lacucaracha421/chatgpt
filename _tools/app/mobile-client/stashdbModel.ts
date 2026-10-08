import {api, ApiError, native} from './transport';
import {outboxConnection} from './outboxConnection';

export const STASHDB_NOT_CONFIGURED = '서버에 StashDB 키가 설정되지 않았습니다.';
export const STASHDB_OLD_SERVER = '서버가 아직 StashDB 조회를 지원하지 않습니다.';
export type StashdbPhoto = {id: string; url: string; width: number; height: number};
export type StashdbPerformer = {stashdbId: string; name: string; aliases: string[]; birthDate: string | null; previewUrl?: string | null; imageUrl?: string | null; images: StashdbPhoto[]};
const validId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function stashdbImagePath(value: string): string {
  if (!value.startsWith('/v1/providers/stashdb/image?') || /[\\#\r\n]/.test(value)) throw new Error('사진 주소를 확인하지 못했습니다.');
  const params = new URLSearchParams(value.slice(value.indexOf('?') + 1));
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size || keys.some(key => !['stashdbId', 'imageId', 'size'].includes(key)) || (params.has('size') && params.get('size') !== 'preview') || !validId(params.get('stashdbId') ?? '') || !validId(params.get('imageId') ?? '')) throw new Error('사진 주소를 확인하지 못했습니다.');
  return value;
}
export function stashdbError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return STASHDB_OLD_SERVER;
  if (error instanceof ApiError && (error.details as {detail?: {code?: string}} | null)?.detail?.code === 'providerNotConfigured') return STASHDB_NOT_CONFIGURED;
  return error instanceof Error ? error.message : 'StashDB 정보를 불러오지 못했습니다.';
}
function pause(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, delay);
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) cancel();
  });
}
// Search, detail and portrait preparation remain serialized across sheets.
let lane: Promise<unknown> = Promise.resolve();
async function retry<T>(run: () => Promise<T>, signal: AbortSignal, connection: string | null): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!connection || connection !== outboxConnection()) throw new Error('서버 연결이 바뀌었습니다. 다시 열어 주세요.');
    try {
      const value = await run();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (connection !== outboxConnection()) throw new Error('서버 연결이 바뀌었습니다. 다시 열어 주세요.');
      return value;
    }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429 || attempt >= 3) throw error;
      await pause(1000 * (attempt + 1), signal);
    }
  }
}
function serial<T>(run: () => Promise<T>, signal: AbortSignal, connection: string | null): Promise<T> {
  const result = lane.catch(() => {}).then(() => retry(run, signal, connection));
  lane = result; return result;
}
// Hold a slot during 429 back-off so retries never exceed the preview limit.
const previews = new Set<Promise<void>>();
async function preview<T>(run: () => Promise<T>, signal: AbortSignal, connection: string | null): Promise<T> {
  while (previews.size >= 3) await Promise.race(previews);
  const result = Promise.resolve().then(() => retry(run, signal, connection));
  const settled = result.then(() => {}, () => {}).then(() => { previews.delete(settled); });
  previews.add(settled);
  return result;
}
export function stashdbRead<T>(path: string, signal: AbortSignal, body?: unknown, connection = outboxConnection()): Promise<T> {
  return serial(() => api<T>(path, signal, body, body === undefined ? 'GET' : 'POST', false, connection ?? undefined), signal, connection);
}
export async function stashdbPreview(value: string, signal: AbortSignal, connection = outboxConnection()): Promise<string> {
  const validated = stashdbImagePath(value);
  const params = new URLSearchParams(validated.slice(validated.indexOf('?') + 1));
  params.set('size', 'preview');
  const path = '/v1/providers/stashdb/image?' + params.toString();
  const reply = await preview(() => native<{url: string}>('providerImage', {path, connection}, signal), signal, connection);
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(reply?.url ?? '')) throw new Error('사진을 불러오지 못했습니다.');
  return reply.url;
}
