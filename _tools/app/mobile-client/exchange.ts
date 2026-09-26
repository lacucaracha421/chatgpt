import type {BatchPart, TimelineEntry} from '../src/exchange/timeline';

/**
 * File exchange (보내기/받기) view model. Native owns the protocol, the device token and every
 * transfer; the web layer only renders its snapshot and asks for user actions.
 */
export type ExchangeRow = {
  transferId: string; batchId: string; fileName: string; sizeBytes: number; bytes: number;
  peer: string; state: string; code: string; createdAt: string;
  /** 폴더 보내기: folder entries left out of the zip because they could not be read. */
  skipped?: number;
  /** False once a folder send's zip is gone: it has to be sent again from the folder. */
  retryable?: boolean;
  /** The other device's id (sender of an incoming row, target of an outgoing one); '' when unknown. */
  peerId?: string;
  /** Saved rows: when the file reached Download/Lakomics. */
  savedAt?: string;
};
export type ExchangeDevice = {deviceId: string; name: string; kind: string; lastSeenAt: string};
export type ExchangeSnapshot = {
  configured: boolean; tokenConfigured: boolean; receiveSupported: boolean; deviceId: string; deviceName: string;
  /** Screen-level problem: '' when the exchange is usable. */
  code: string;
  devices: ExchangeDevice[]; incoming: ExchangeRow[]; outgoing: ExchangeRow[]; unseen: number;
};
export type ExchangeArrival = {count: number; fromName: string; fromKind: string};

export const EXCHANGE_EVENT = 'lakomics-exchange';
export const EXCHANGE_ARRIVED_EVENT = 'lakomics-exchange-arrived';
export const EXCHANGE_NOTICE_EVENT = 'lakomics-exchange-notice';

const RETRYING = '서버에 연결할 수 없음 — 자동 재시도';
/** Per-row failure codes (native codes and the server's `code`/`failure` values). */
const ROW_MESSAGES: Record<string, string> = {
  network: RETRYING, server: RETRYING, storageUnavailable: RETRYING, request: '요청을 처리하지 못함',
  transferNotReady: '아직 업로드 중 — 자동 재시도',
  fileTooLarge: '파일이 너무 큼 (최대 2GB)',
  quotaExceeded: '보관 한도 초과',
  batchTooLarge: '한 번에 최대 100개까지 보낼 수 있음',
  expired: '만료됨 (받지 않음)', transferGone: '만료됨 (받지 않음)', transferUnknown: '만료됨 (받지 않음)',
  noSpace: '저장 공간 부족',
  targetDeviceUnknown: '받는 기기가 등록 해제됨', deviceUnregistered: '받는 기기가 등록 해제됨',
  digest: '받은 파일이 손상됨 — 다시 받기', digestMismatch: '받은 파일이 손상됨 — 다시 받기',
  sizeMismatch: '업로드된 크기가 다름 — 다시 보내기', uploadMissing: '업로드가 끝나지 않음 — 다시 보내기',
  sourceUnavailable: '원본 파일을 읽을 수 없음 — 다시 선택해 주세요',
  interrupted: '앱이 닫혀 중단됨',
  folderTooLarge: '폴더가 너무 큼 (압축 파일 최대 2GB)',
  folderUnreadable: '폴더를 읽을 수 없음 — 다시 선택해 주세요',
  zipFailed: '압축하지 못함',
  unsupported: 'Android 10 이상에서만 받을 수 있음',
  withdrawn: '보낸 기기에서 취소함', declined: '받는 기기에서 받지 않음',
};
const AUTOMATIC = new Set(['network', 'server', 'storageUnavailable', 'transferNotReady']);

export function rowMessage(code: string): string {
  return ROW_MESSAGES[code] ?? '실패';
}

/** Codes that mean "this device needs (another) exchange token". */
export const TOKEN_CODES = new Set(['tokenMissing', 'exchangeDeviceTokenRequired', 'tokenInvalid', 'tokenForbidden', 'exchangeDeviceForbidden']);

export function screenMessage(code: string): string {
  switch (code) {
    case '': return '';
    case 'notConfigured': return '먼저 서버를 연결해 주세요.';
    case 'tokenMissing': return '보내기/받기에는 이 기기 전용 토큰이 필요합니다. 라이브러리 연결에 쓰는 공용 토큰과 별도로, 서버에서 이 기기용으로 발급한 토큰을 입력해 주세요.';
    case 'exchangeDeviceTokenRequired': return '공용 토큰으로는 보내기/받기를 쓸 수 없습니다. 이 기기 전용 토큰을 입력해 주세요.';
    case 'tokenInvalid': case 'tokenForbidden': return '이 기기의 보내기/받기 토큰이 거부되었습니다. 토큰을 확인해 주세요.';
    case 'exchangeDeviceForbidden': return '이 기기는 다른 토큰으로 등록되어 있습니다. 처음 등록한 토큰을 입력하거나, 이전 토큰을 폐기한 뒤 새 토큰을 입력해 주세요.';
    case 'exchangeDeviceLimit': return '서버에 등록할 수 있는 기기 수를 넘었습니다.';
    case 'unavailable': return '서버가 아직 파일 보내기/받기를 지원하지 않습니다.';
    default: return AUTOMATIC.has(code) ? RETRYING : '보내기/받기 상태를 확인하지 못했습니다. 잠시 후 다시 시도합니다.';
  }
}

/** The server's structured error code carried by a failed bridge call, if any. */
export function errorCode(reason: unknown): string {
  const details = (reason as {details?: unknown} | null)?.details;
  const status = (reason as {status?: unknown} | null)?.status;
  const body = details && typeof details === 'object' ? details as Record<string, unknown> : null;
  const inner = body && typeof body.detail === 'object' && body.detail ? body.detail as Record<string, unknown> : body;
  if (inner && typeof inner.code === 'string') return inner.code;
  if (status === 401) return 'tokenInvalid';
  if (status === 403) return 'tokenForbidden';
  if (status === 404) return 'unavailable';
  return '';
}

export type RowTone = 'active' | 'waiting' | 'done' | 'error' | 'muted';
export type RowAction = 'open' | 'retry' | 'cancel';
export type RowView = {label: string; tone: RowTone; progress: number | null; actions: RowAction[]};

function ratio(row: ExchangeRow): number | null {
  return row.sizeBytes > 0 ? Math.max(0, Math.min(1, row.bytes / row.sizeBytes)) : null;
}

export function rowView(row: ExchangeRow, incoming: boolean): RowView {
  if (incoming) switch (row.state) {
    case 'waiting': return {label: '받기 대기 중', tone: 'waiting', progress: null, actions: ['cancel']};
    case 'downloading': return {label: '받는 중', tone: 'active', progress: ratio(row), actions: ['cancel']};
    case 'saving': return {label: '다운로드 폴더에 저장 중', tone: 'active', progress: 1, actions: []};
    case 'saved': return {label: '다운로드 폴더에 저장됨', tone: 'done', progress: null, actions: ['open']};
    case 'expired': return {label: '만료됨 (받지 않음)', tone: 'muted', progress: null, actions: []};
    case 'cancelled': return {label: '보낸 기기에서 취소함', tone: 'muted', progress: null, actions: []};
    case 'failed': return {label: rowMessage(row.code), tone: 'error', progress: null, actions: AUTOMATIC.has(row.code) ? ['cancel'] : ['retry', 'cancel']};
    default: return {label: row.state, tone: 'muted', progress: null, actions: []};
  }
  const retry: RowAction[] = row.retryable === false ? ['cancel'] : ['retry', 'cancel'];
  switch (row.state) {
    case 'zipping': return {label: '압축 중', tone: 'active', progress: ratio(row), actions: ['cancel']};
    case 'preparing': return {label: '보낼 준비 중', tone: 'active', progress: null, actions: ['cancel']};
    case 'uploading': return {label: '업로드 중', tone: 'active', progress: ratio(row), actions: ['cancel']};
    case 'completing': return {label: '업로드 확인 중', tone: 'active', progress: 1, actions: []};
    case 'ready': return {label: '대기 중 (받으면 삭제됨)', tone: 'waiting', progress: null, actions: ['cancel']};
    case 'delivered': return {label: '전달됨', tone: 'done', progress: null, actions: []};
    case 'expired': return {label: '만료됨 (받지 않음)', tone: 'muted', progress: null, actions: []};
    case 'cancelled': return {label: row.code === 'declined' ? '받는 기기에서 받지 않음' : row.code === 'deviceUnregistered' ? '받는 기기가 등록 해제됨' : '취소됨', tone: 'muted', progress: null, actions: []};
    case 'stalled': return {label: '업로드 중단됨', tone: 'error', progress: null, actions: ['cancel']};
    case 'failed': return {label: rowMessage(row.code), tone: 'error', progress: null,
      actions: AUTOMATIC.has(row.code) ? ['cancel'] : row.code === 'sourceUnavailable' ? ['cancel'] : retry};
    default: return {label: row.state, tone: 'muted', progress: null, actions: []};
  }
}

/** "PC에서 파일 2개" */
export function arrivalText(arrival: ExchangeArrival): string {
  const from = arrival.fromKind === 'pc' ? 'PC' : arrival.fromName || '다른 기기';
  return `${from}에서 파일 ${arrival.count}개`;
}

/** The default target: the only other device, or the first PC. */
export function defaultTarget(devices: ExchangeDevice[], chosen: string): ExchangeDevice | undefined {
  return devices.find(device => device.deviceId === chosen) ?? devices.find(device => device.kind === 'pc') ?? devices[0];
}

/** Whether `row` was exchanged with `device`. Rows whose device is gone follow the chosen one. */
export function withDevice(row: ExchangeRow, device: ExchangeDevice, devices: ExchangeDevice[]): boolean {
  const matches = (candidate: ExchangeDevice) => row.peerId ? row.peerId === candidate.deviceId : !!row.peer && row.peer === candidate.name;
  return matches(device) || !devices.some(matches);
}

/** Entries of the timeline with `device`; `receivedOnly` leaves out what this tablet sent. */
export function timelineEntries(snapshot: ExchangeSnapshot, device: ExchangeDevice, receivedOnly: boolean): TimelineEntry<ExchangeRow>[] {
  const entry = (row: ExchangeRow, mine: boolean): TimelineEntry<ExchangeRow> =>
    ({row, transferId: row.transferId, batchId: row.batchId || row.transferId, mine, at: row.createdAt});
  const incoming = snapshot.incoming.filter(row => withDevice(row, device, snapshot.devices)).map(row => entry(row, false));
  if (receivedOnly) return incoming;
  return [...incoming, ...snapshot.outgoing.filter(row => withDevice(row, device, snapshot.devices)).map(row => entry(row, true))];
}

const FINISHED = new Set(['saved', 'delivered', 'ready', 'completing', 'saving']);
const MOVING = new Set(['uploading', 'downloading']);
/** A row's share of its batch's combined progress. */
export function batchPart(row: ExchangeRow): BatchPart {
  const size = Math.max(0, row.sizeBytes);
  return {size, done: FINISHED.has(row.state) ? size : MOVING.has(row.state) ? row.bytes : 0, finished: FINISHED.has(row.state)};
}

/** Transfers still moving (or about to), for the device list and the combined bar. */
export const ACTIVE_STATES = new Set(['waiting', 'downloading', 'saving', 'zipping', 'preparing', 'uploading', 'completing']);
