import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({native: vi.fn()}));
vi.mock('./transport', () => ({native: mocks.native, errorText: (reason: unknown) => reason instanceof Error ? reason.message : '오류'}));
import {Exchange} from './Exchange';
import {useExchange} from './useExchange';
import {arrivalText, errorCode, rowView, screenMessage, EXCHANGE_ARRIVED_EVENT, EXCHANGE_EVENT, type ExchangeRow, type ExchangeSnapshot} from './exchange';

const PC = {deviceId: '11111111-1111-4111-8111-111111111111', name: 'DESKTOP', kind: 'pc', lastSeenAt: ''};
function row(values: Partial<ExchangeRow>): ExchangeRow {
  return {transferId: '22222222-2222-4222-8222-222222222222', batchId: 'b', fileName: 'movie.mp4', sizeBytes: 2048, bytes: 0, peer: 'DESKTOP', state: 'waiting', code: '', createdAt: '', ...values};
}
function snapshot(values: Partial<ExchangeSnapshot> = {}): ExchangeSnapshot {
  return {configured: true, tokenConfigured: true, receiveSupported: true, deviceId: 'd', deviceName: 'Galaxy Tab S11', code: '', devices: [PC], incoming: [], outgoing: [], unseen: 0, ...values};
}
beforeEach(() => { mocks.native.mockReset(); });
afterEach(cleanup);

function show(state: ExchangeSnapshot) {
  mocks.native.mockImplementation(async (op: string) => op === 'exchangeVisible' ? state : state);
  const onSnapshot = vi.fn();
  const view = render(<Exchange snapshot={state} onSnapshot={onSnapshot} backRef={{current: null}} onClose={vi.fn()}/>);
  return {onSnapshot, ...view};
}

it('marks the screen visible while open and not after it closes', async () => {
  const {unmount, onSnapshot} = show(snapshot());
  expect(mocks.native).toHaveBeenCalledWith('exchangeVisible', {visible: true});
  await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalled());
  unmount();
  expect(mocks.native).toHaveBeenLastCalledWith('exchangeVisible', {visible: false});
});

it('asks for a device token instead of failing silently when the shared token is refused', async () => {
  show(snapshot({tokenConfigured: false, code: 'tokenMissing'}));
  expect(screen.getByText(/이 기기 전용 토큰이 필요합니다/)).toBeTruthy();
  expect(screen.queryByRole('button', {name: /파일 보내기/})).toBeNull();
  mocks.native.mockImplementation(async (op: string) => {
    if (op === 'exchangeToken') throw Object.assign(new Error('인증 실패'), {status: 403, details: {detail: {code: 'exchangeDeviceTokenRequired'}}});
    return snapshot({tokenConfigured: false, code: 'tokenMissing'});
  });
  fireEvent.change(screen.getByLabelText('이 기기 전용 토큰'), {target: {value: ' shared-token '}});
  fireEvent.click(screen.getByRole('button', {name: '확인하고 저장'}));
  expect(mocks.native).toHaveBeenCalledWith('exchangeToken', {token: 'shared-token'});
  await screen.findByText('공용 토큰으로는 보내기/받기를 쓸 수 없습니다. 이 기기 전용 토큰을 입력해 주세요.');
});

it('sends to the PC through the system picker', () => {
  show(snapshot());
  fireEvent.click(screen.getByRole('button', {name: 'DESKTOP(으)로 파일 보내기'}));
  expect(mocks.native).toHaveBeenCalledWith('exchangeSend', {toDevice: PC.deviceId});
});

it('sends a folder through the system folder picker', () => {
  show(snapshot());
  fireEvent.click(screen.getByRole('button', {name: '폴더 보내기'}));
  expect(mocks.native).toHaveBeenCalledWith('exchangeSendFolder', {toDevice: PC.deviceId});
});

it('shows zipping progress, skipped entries and folder-only failures', () => {
  const zipping = row({transferId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', fileName: '여행.zip', state: 'zipping', sizeBytes: 1000, bytes: 420});
  const skipped = row({transferId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fileName: '문서.zip', state: 'ready', skipped: 3});
  const tooLarge = row({transferId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', fileName: '영상.zip', state: 'failed', code: 'folderTooLarge', retryable: false});
  show(snapshot({outgoing: [zipping, skipped, tooLarge]}));
  expect(screen.getByText('압축 중 42%')).toBeTruthy();
  expect(screen.getByText(/읽지 못한 항목 3개 제외/)).toBeTruthy();
  expect(screen.getByText('폴더가 너무 큼 (압축 파일 최대 2GB)')).toBeTruthy();
  // A zip that is gone cannot be retried; zipping can be cancelled.
  expect(screen.queryByRole('button', {name: '재시도'})).toBeNull();
  fireEvent.click(screen.getAllByRole('button', {name: '취소'})[0]);
  expect(mocks.native).toHaveBeenCalledWith('exchangeCancel', {transferId: zipping.transferId});
});

it('shows each row state with its action', async () => {
  const saved = row({transferId: '33333333-3333-4333-8333-333333333333', fileName: 'a.pdf', state: 'saved', bytes: 2048});
  const receiving = row({transferId: '44444444-4444-4444-8444-444444444444', fileName: 'b.zip', state: 'downloading', bytes: 512});
  const full = row({transferId: '55555555-5555-4555-8555-555555555555', fileName: 'c.mov', state: 'failed', code: 'noSpace'});
  const uploading = row({transferId: '66666666-6666-4666-8666-666666666666', fileName: 'd.jpg', state: 'uploading', bytes: 1024});
  const waiting = row({transferId: '77777777-7777-4777-8777-777777777777', fileName: 'e.jpg', state: 'ready'});
  const quota = row({transferId: '88888888-8888-4888-8888-888888888888', fileName: 'f.iso', state: 'failed', code: 'quotaExceeded'});
  show(snapshot({incoming: [receiving, full, saved], outgoing: [uploading, waiting, quota,
    row({transferId: '99999999-9999-4999-8999-999999999999', fileName: 'g.txt', state: 'delivered'}),
    row({transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fileName: 'h.txt', state: 'expired'}),
    row({transferId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fileName: 'i.txt', state: 'failed', code: 'network'})]}));
  expect(screen.getByText('받는 중 25%')).toBeTruthy();
  expect(screen.getByText('저장 공간 부족')).toBeTruthy();
  expect(screen.getByText('업로드 중 50%')).toBeTruthy();
  expect(screen.getByText('대기 중 (받으면 삭제됨)')).toBeTruthy();
  expect(screen.getByText('보관 한도 초과')).toBeTruthy();
  expect(screen.getByText('전달됨')).toBeTruthy();
  expect(screen.getByText('만료됨 (받지 않음)')).toBeTruthy();
  expect(screen.getByText('서버에 연결할 수 없음 — 자동 재시도')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'a.pdf, 다운로드 폴더에 저장됨, 열기'}));
  expect(mocks.native).toHaveBeenCalledWith('exchangeOpen', {transferId: saved.transferId});
  // Two failures offer 재시도 (no space, quota); the automatic network retry does not.
  const retries = screen.getAllByRole('button', {name: '재시도'});
  expect(retries).toHaveLength(2);
  fireEvent.click(retries[1]);
  expect(mocks.native).toHaveBeenCalledWith('exchangeRetry', {transferId: quota.transferId});
});

it('hides receiving on Android versions that cannot write Downloads', () => {
  show(snapshot({receiveSupported: false}));
  expect(screen.queryByRole('region', {name: '받은 파일'})).toBeNull();
  expect(screen.getByText(/받기를 지원하지 않습니다/)).toBeTruthy();
  expect(screen.getByRole('button', {name: /파일 보내기/})).toBeTruthy();
});

it('maps codes and labels', () => {
  expect(arrivalText({count: 2, fromName: 'DESKTOP', fromKind: 'pc'})).toBe('PC에서 파일 2개');
  expect(arrivalText({count: 1, fromName: '노트북', fromKind: 'android'})).toBe('노트북에서 파일 1개');
  expect(errorCode({status: 403, details: {detail: {code: 'exchangeDeviceTokenRequired'}}})).toBe('exchangeDeviceTokenRequired');
  expect(errorCode({status: 401, details: {detail: 'Unauthorized'}})).toBe('tokenInvalid');
  expect(errorCode({status: 404, details: null})).toBe('unavailable');
  expect(screenMessage('unavailable')).toBe('서버가 아직 파일 보내기/받기를 지원하지 않습니다.');
  expect(rowView(row({state: 'failed', code: 'fileTooLarge'}), false).label).toBe('파일이 너무 큼 (최대 2GB)');
  expect(rowView(row({state: 'failed', code: 'targetDeviceUnknown'}), false).label).toBe('받는 기기가 등록 해제됨');
  expect(rowView(row({state: 'saved'}), true).actions).toEqual(['open']);
});

function Probe({open = false}: {open?: boolean}) {
  const exchange = useExchange(true, 'https://example.invalid', open);
  return <div><span data-testid="unseen">{exchange.unseen}</span>{exchange.toast && <p>{exchange.toast.text}</p>}</div>;
}

it('turns native arrivals into a badge count and a toast', async () => {
  mocks.native.mockResolvedValue(snapshot());
  render(<Probe/>);
  await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledWith('exchangeState'));
  act(() => { window.dispatchEvent(new CustomEvent(EXCHANGE_EVENT, {detail: snapshot({unseen: 2})})); });
  expect(screen.getByTestId('unseen').textContent).toBe('2');
  act(() => { window.dispatchEvent(new CustomEvent(EXCHANGE_ARRIVED_EVENT, {detail: {count: 2, fromName: 'DESKTOP', fromKind: 'pc'}})); });
  expect(screen.getByText('PC에서 파일 2개')).toBeTruthy();
});

it('keeps the toast away while the screen itself is open', () => {
  mocks.native.mockResolvedValue(snapshot());
  render(<Probe open/>);
  act(() => { window.dispatchEvent(new CustomEvent(EXCHANGE_ARRIVED_EVENT, {detail: {count: 1, fromName: 'DESKTOP', fromKind: 'pc'}})); });
  expect(screen.queryByText('PC에서 파일 1개')).toBeNull();
});
