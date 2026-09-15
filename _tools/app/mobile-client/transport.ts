declare global {
  interface Window { LakomicsNative?: {request(id: string, operation: string, payload: string): void; cancel(id: string): void} }
}
type Reply = {id: string; ok: boolean; data?: unknown; error?: string; status?: number; details?: unknown};
type Pending = {resolve(value: unknown): void; reject(error: Error): void; cleanup(): void};
const pending = new Map<string, Pending>();
let sequence = 0;
let developmentTransport: ((op: string, payload: Record<string, unknown>) => Promise<unknown>) | undefined;

/**
 * A native/API failure that keeps the server's own status and structured detail.
 *
 * The native bridge already distinguishes authorization, timeout and transport
 * failures in its message. The status and the server's `detail` are carried
 * alongside so a caller can tell an authoritative revision conflict from an
 * identity mismatch instead of treating every non-2xx as one generic failure.
 * Nothing here is rendered directly: callers format their own text.
 */
export class ApiError extends Error {
  readonly status: number | null;
  readonly details: unknown;
  constructor(message: string, status: number | null, details: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

window.addEventListener('lakomics-native', event => {
  const reply = (event as CustomEvent<Reply>).detail;
  const entry = pending.get(reply?.id);
  if (!entry) return;
  pending.delete(reply.id); entry.cleanup();
  if (reply.ok) entry.resolve(reply.data);
  else entry.reject(new ApiError(typeof reply.error === 'string' ? reply.error : '요청을 완료하지 못했습니다.', typeof reply.status === 'number' ? reply.status : null, reply.details));
});
export function setDevelopmentTransport(transport: typeof developmentTransport) {
  if (import.meta.env.DEV) developmentTransport = transport;
}
export function native<T>(operation: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  if (import.meta.env.DEV && developmentTransport) return developmentTransport(operation, payload) as Promise<T>;
  if (!window.LakomicsNative) {
    if (operation === 'status') return Promise.resolve({configured: false, endpoint: ''} as T);
    return Promise.reject(new Error('서버 연결은 Android 앱에서 설정할 수 있습니다.'));
  }
  return new Promise<T>((resolve, reject) => {
    const id = String(++sequence);
    const abort = () => { window.LakomicsNative?.cancel(id); pending.delete(id); cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = window.setTimeout(() => { window.LakomicsNative?.cancel(id); pending.delete(id); cleanup(); reject(new Error('연결 시간이 초과되었습니다. 다시 시도해 주세요.')); }, 45_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    pending.set(id, {resolve: value => resolve(value as T), reject, cleanup});
    signal?.addEventListener('abort', abort, {once: true});
    try { window.LakomicsNative!.request(id, operation, JSON.stringify(payload)); }
    catch { pending.delete(id); cleanup(); reject(new Error('앱 연결을 시작하지 못했습니다.')); }
  });
}
export function api<T>(path: string, signal?: AbortSignal, body?: unknown, method?: 'GET' | 'POST' | 'PUT'): Promise<T> {
  // An explicit method only ever refines a body-bearing request; a bodyless call
  // stays a read, so no existing caller can accidentally become a write.
  const resolved = method ?? (body === undefined ? 'GET' : 'POST');
  return native<T>('api', {path, method: resolved, ...(body === undefined ? {} : {body})}, signal);
}
export function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  // Native supplies sanitized messages. Never show arbitrary server payloads or signed URLs.
  if (error instanceof Error && !/https?:|bearer|token=/i.test(error.message)) return error.message.slice(0, 180);
  return '연결을 확인한 뒤 다시 시도해 주세요.';
}
