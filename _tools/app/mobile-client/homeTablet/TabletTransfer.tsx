import {useState} from 'react';
import {ChevronRightIcon} from '@heroicons/react/24/outline';
import {defaultTarget, errorCode, rowView, screenMessage, TOKEN_CODES, type ExchangeRow, type ExchangeSnapshot, type RowTone} from '../exchangeModel';
import {blockRoute, type ExchangeRoute} from '../../src/exchange/route';
import {TransferMark, transferTone, type TransferTone} from '../../src/home/TransferMark';
import {isImageName} from '../../src/exchange/timeline';
import {SectionLabel} from '../ui';
import {errorText, native} from '../transport';

export type TransferLine = {key: string; label: string; state: string; tone: RowTone; route: ExchangeRoute | null};
const TONE_ORDER: RowTone[] = ['error', 'active', 'waiting', 'done', 'muted'];
const MARK: Record<RowTone, TransferTone> = {active: 'moving', waiting: 'waiting', error: 'failed', done: 'idle', muted: 'idle'};

/** The newest sends to the target, the files of one batch folded into one line. */
export function recentSends(outgoing: ExchangeRow[], limit = 3): TransferLine[] {
  const groups = new Map<string, ExchangeRow[]>();
  for (const row of outgoing) groups.set(row.batchId || row.transferId, [...(groups.get(row.batchId || row.transferId) ?? []), row]);
  const newest = (rows: ExchangeRow[]) => Math.max(...rows.map(row => Date.parse(row.createdAt) || 0));
  return [...groups.entries()].sort((a, b) => newest(b[1]) - newest(a[1])).slice(0, limit).map(([key, rows]) => {
    const views = rows.map(row => rowView(row, false));
    // One line takes the most pressing state of its files.
    const view = views.slice().sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone))[0]!;
    const label = rows.length === 1 ? rows[0]!.fileName : rows.every(row => isImageName(row.fileName)) ? `사진 ${rows.length}장` : `파일 ${rows.length}개`;
    return {key, label, state: view.label, tone: view.tone, route: blockRoute(rows.map(row => row.route))};
  });
}

/**
 * 전송 on the tablet: one tile that opens the system file picker and sends to the PC through the exchange
 * screen's own send (`exchangeSend`). Icon only as on the PC (user 2026-10-18): the icon shows the newest send's
 * state and 상세 keeps the list. There is no drop target on a tablet.
 */
export function TabletTransfer({exchange, onOpenDetail, send = (toDevice: string) => native('exchangeSend', {toDevice})}: {exchange: ExchangeSnapshot | null; onOpenDetail(): void; send?(toDevice: string): Promise<unknown>}) {
  const [error, setError] = useState('');
  const code = exchange?.code ?? '';
  const usable = !!exchange && exchange.configured && exchange.tokenConfigured && !TOKEN_CODES.has(code) && code !== 'unavailable';
  const target = usable ? defaultTarget(exchange.devices, '') : undefined;
  const name = target ? (target.kind === 'pc' ? 'PC' : target.name) : 'PC';
  const lines = usable && target ? recentSends(exchange.outgoing.filter(row => !row.peerId || row.peerId === target.deviceId)) : [];
  const why = !exchange ? '' : !exchange.configured ? '먼저 서버를 연결해 주세요.' : !usable ? screenMessage(TOKEN_CODES.has(code) ? code : code === 'unavailable' ? code : 'tokenMissing') : !target ? '받을 기기가 없습니다' : '';
  const choose = () => {
    if (!target) return;
    setError('');
    void send(target.deviceId).catch(reason => setError(errorText(reason) || screenMessage(errorCode(reason)) || '파일을 보내지 못했습니다.'));
  };
  const {tone: sendTone, line} = transferTone(lines, item => MARK[item.tone]);
  const tone: TransferTone = error ? 'failed' : sendTone;
  const action = target ? `${name}로 파일 보내기` : why || '파일 보내기';
  const status = error ? `보내지 못했습니다: ${error}` : line ? `${line.label} ${line.state}` : '';
  const label = status ? `${status} · ${action}` : action;
  return <section className="home-attention-section home-tool home-tab-transfer" aria-label="전송">
    <SectionLabel title="전송" actions={<button type="button" className="home-link" onClick={onOpenDetail}>상세<ChevronRightIcon aria-hidden="true" /></button>} />
    <div className="home-tool__body">
      <button type="button" className="home-tab-transfer__send transfer-tile" disabled={!target} aria-label={label} onClick={choose}>
        <TransferMark tone={tone} settled={!!exchange} note={tone === 'failed' ? '보내지 못했습니다' : target ? undefined : why || undefined}/>
      </button>
      {error && <p className="transfer-alert" role="alert">{error}</p>}
    </div>
  </section>;
}
