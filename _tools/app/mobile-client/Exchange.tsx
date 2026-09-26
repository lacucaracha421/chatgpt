import {Fragment, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject} from 'react';
import {
  ArrowLeftIcon, ArrowsUpDownIcon, CheckIcon, ChevronDownIcon, ComputerDesktopIcon, DeviceTabletIcon, EllipsisHorizontalIcon,
  ExclamationTriangleIcon, FolderIcon, PaperClipIcon,
} from '@heroicons/react/24/outline';
import {Button, IconButton} from './ui';
import {errorText, native} from './transport';
import {formatBytes} from './libraryTrash';
import {useExchangeThumbnail} from './useExchange';
import {
  ACTIVE_STATES, batchPart, defaultTarget, errorCode, EXCHANGE_NOTICE_EVENT, rowView, screenMessage, timelineEntries, TOKEN_CODES, withDevice,
  type ExchangeDevice, type ExchangeRow, type ExchangeSnapshot,
} from './exchange';
import {batchProgress, buildTimeline, clockLabel, dayKey, dayLabel, extensionLabel, isImageName, withParticle, type TimelineBlock} from '../src/exchange/timeline';
import './exchange.css';

type Actions = {onOpen(id: string): void; onRetry(id: string): void; onCancel(id: string): void};

/**
 * 전송: everything sent to and received from one other device, stacked by time like a
 * conversation (mine on the right). Arrivals save themselves into Download/Lakomics while the
 * app is open; while this screen is open, native refreshes the inbox and outbox every 5 s.
 */
export function Exchange({snapshot, onSnapshot, backRef, onClose}: {
  snapshot: ExchangeSnapshot | null;
  onSnapshot(snapshot: ExchangeSnapshot): void;
  backRef: MutableRefObject<(() => boolean) | null>;
  onClose(): void;
}) {
  const [chosen, setChosen] = useState('');
  const [notice, setNotice] = useState('');
  const [editingToken, setEditingToken] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [receivedOnly, setReceivedOnly] = useState(false);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    backRef.current = () => {
      if (choosing) { setChoosing(false); return true; }
      if (editingToken) { setEditingToken(false); return true; }
      onClose(); return true;
    };
    return () => { backRef.current = null; };
  }, [backRef, onClose, editingToken, choosing]);

  useEffect(() => {
    let active = true;
    void native<ExchangeSnapshot>('exchangeVisible', {visible: true}).then(value => { if (active) onSnapshot(value); })
      .catch(reason => { if (active) setNotice(errorText(reason)); });
    const onNotice = (event: Event) => { const message = (event as CustomEvent<{message?: string}>).detail?.message; if (message) setNotice(message); };
    window.addEventListener(EXCHANGE_NOTICE_EVENT, onNotice);
    return () => { active = false; window.removeEventListener(EXCHANGE_NOTICE_EVENT, onNotice); void native('exchangeVisible', {visible: false}).catch(() => {}); };
  }, [onSnapshot]);

  const code = snapshot?.code ?? '';
  const needsToken = TOKEN_CODES.has(code);
  const showToken = needsToken || editingToken;
  const devices = snapshot?.devices ?? [];
  const target = defaultTarget(devices, chosen);
  const usable = !!snapshot && snapshot.configured && snapshot.tokenConfigured && !needsToken && code !== 'unavailable';

  const run = (operation: string, transferId: string) => {
    setNotice('');
    void native<ExchangeSnapshot>(operation, {transferId}).then(onSnapshot).catch(reason => setNotice(errorText(reason)));
  };
  const actions: Actions = {
    onOpen: transferId => { setNotice(''); void native('exchangeOpen', {transferId}).catch(reason => setNotice(errorText(reason))); },
    onRetry: id => run('exchangeRetry', id),
    onCancel: id => run('exchangeCancel', id),
  };
  const send = (operation: 'exchangeSend' | 'exchangeSendFolder') => {
    if (!target) return;
    setNotice('');
    void native(operation, {toDevice: target.deviceId}).catch(reason => setNotice(errorText(reason)));
  };
  const saveToken = (value: string) => {
    setBusy(true); setTokenError('');
    void native<ExchangeSnapshot>('exchangeToken', {token: value}).then(result => {
      onSnapshot(result); setToken(''); setEditingToken(false);
    }).catch(reason => {
      const message = screenMessage(errorCode(reason));
      setTokenError(errorCode(reason) ? message : errorText(reason));
    }).finally(() => setBusy(false));
  };

  const blocks = usable && target ? buildTimeline(timelineEntries(snapshot, target, receivedOnly)) : [];
  const scroller = useRef<HTMLDivElement>(null);
  const shown = useRef({count: 0, device: ''});
  // Open at the newest end, and follow new blocks while the reader is already there.
  useLayoutEffect(() => {
    const element = scroller.current;
    const previous = shown.current;
    shown.current = {count: blocks.length, device: target?.deviceId ?? ''};
    if (!element || blocks.length === previous.count && previous.device === shown.current.device) return;
    const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (previous.count === 0 || previous.device !== shown.current.device || nearEnd) element.scrollTop = element.scrollHeight;
  });

  const statusLabel = !usable ? '' : code === '' ? '연결됨' : code === 'network' || code === 'server' || code === 'storageUnavailable' ? '다시 연결하는 중' : '';
  const peerName = target?.name ?? '';
  const receiveNote = '받은 파일은 앱이 열려 있을 때 다운로드/Lakomics 폴더에 저장됩니다.';

  return <div className="exchange-overlay" role="dialog" aria-modal="true" aria-label="전송">
    <header className="exchange-bar">
      <IconButton label="전송 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="exchange-title">
        <h1>전송</h1>
        {usable && target && (devices.length > 1
          ? <button type="button" className="exchange-peer" aria-haspopup="dialog" onClick={() => setChoosing(true)}><DeviceIcon device={target}/>{withParticle(peerName, '과', '와')} 주고받은 파일<ChevronDownIcon aria-hidden="true"/></button>
          : <p className="exchange-peer"><DeviceIcon device={target}/>{withParticle(peerName, '과', '와')} 주고받은 파일</p>)}
        {(!usable || !target) && snapshot?.deviceName && <p className="exchange-peer">{snapshot.deviceName}</p>}
      </div>
      {usable && target && snapshot.receiveSupported && <div className="exchange-filter" role="group" aria-label="보기">
        <button type="button" aria-pressed={!receivedOnly} onClick={() => setReceivedOnly(false)}>전체</button>
        <button type="button" aria-pressed={receivedOnly} onClick={() => setReceivedOnly(true)}>받은 파일</button>
      </div>}
      {statusLabel && <span className="exchange-status" role="status"><span className="exchange-dot" data-live={code === ''} aria-hidden="true"/>{statusLabel}</span>}
      {snapshot?.configured && snapshot.tokenConfigured && !needsToken && <IconButton label="기기 토큰 변경" icon={EllipsisHorizontalIcon} active={editingToken} onClick={() => setEditingToken(value => !value)}/>}
    </header>
    <div className="exchange-scroll" ref={scroller}>
      {!snapshot && <div className="loading-line" role="status" aria-label="전송 불러오는 중"/>}
      {(code && !needsToken || notice || showToken && snapshot?.configured || usable && !snapshot.receiveSupported) && <div className="exchange-notices">
        {code && !needsToken && <p className={code === 'network' || code === 'server' ? 'hint exchange-notice' : 'error-message exchange-notice'} role="status">{screenMessage(code)}</p>}
        {notice && <p className="error-message exchange-notice" role="alert">{notice}</p>}
        {showToken && snapshot?.configured && <form className="exchange-token" onSubmit={event => { event.preventDefault(); if (token.trim()) saveToken(token.trim()); }}>
          <p>{screenMessage(needsToken ? code : 'tokenMissing')}</p>
          <label className="field">이 기기 전용 토큰<input type="password" required value={token} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => setToken(event.target.value)}/></label>
          {tokenError && <p className="error-message" role="alert">{tokenError}</p>}
          <div className="exchange-token-actions">
            {editingToken && !needsToken && <Button variant="ghost" type="button" onClick={() => setEditingToken(false)}>취소</Button>}
            <Button variant="primary" type="submit" disabled={busy || !token.trim()}>{busy ? '확인 중' : '확인하고 저장'}</Button>
          </div>
        </form>}
        {usable && !snapshot.receiveSupported && <p className="hint exchange-notice">이 Android 버전에서는 받기를 지원하지 않습니다 (Android 10 이상 필요). 보내기는 사용할 수 있습니다.</p>}
      </div>}

      {usable && devices.length === 0 && <Empty title="받을 기기가 없습니다" text="PC의 Lakomics에서 전송 화면을 한 번 열면 여기에 나타납니다."/>}
      {usable && target && (blocks.length
        ? <ol className="exchange-timeline" aria-label={`${withParticle(peerName, '과', '와')} 주고받은 파일`}>
            {blocks.map((block, index) => <Fragment key={block.key}>
              {dayKey(block.at) && dayKey(block.at) !== dayKey(blocks[index - 1]?.at ?? '') && <DaySeparator at={block.at}/>}
              <Block block={block} peerName={block.entries[0].row.peer || peerName} actions={actions}/>
            </Fragment>)}
          </ol>
        : receivedOnly
          ? <Empty title={`${peerName}에게서 받은 파일이 없습니다`} text={receiveNote}/>
          : <Empty title={`${withParticle(peerName, '과', '와')} 주고받은 파일이 없습니다`}
              text={`여기서 보낸 파일과 받은 파일이 시간순으로 쌓입니다. ${receiveNote} 다른 앱의 공유 메뉴에서 Lakomics를 골라도 보낼 수 있습니다.`}
              limits={['파일당 최대 2GB', '폴더는 zip 하나로', '안 받으면 24시간 뒤 삭제']}/>)}
    </div>
    {usable && target && <footer className="exchange-composer">
      <p className="exchange-composer-to"><b>{peerName}(으)로 보내기</b>파일당 최대 2GB · 받지 않으면 24시간 뒤 삭제</p>
      <Button className="exchange-composer-button" aria-label="폴더 보내기" onClick={() => send('exchangeSendFolder')}><FolderIcon aria-hidden="true"/>폴더</Button>
      <Button variant="primary" className="exchange-composer-button" aria-label={`${peerName}(으)로 파일 보내기`} onClick={() => send('exchangeSend')}><PaperClipIcon aria-hidden="true"/>파일 보내기</Button>
    </footer>}
    {choosing && snapshot && <>
      <div className="exchange-menu-scrim" aria-hidden="true" onClick={() => setChoosing(false)}/>
      <div className="exchange-devices" role="radiogroup" aria-label="주고받을 기기">
        {devices.map(device => {
          const moving = [...snapshot.incoming, ...snapshot.outgoing].filter(row => ACTIVE_STATES.has(row.state) && withDevice(row, device, devices)).length;
          return <button key={device.deviceId} type="button" role="radio" aria-checked={device.deviceId === target?.deviceId} className="exchange-device"
            onClick={() => { setChosen(device.deviceId); setChoosing(false); }}>
            <DeviceIcon device={device}/><span>{device.name}</span>{moving > 0 && <span className="numeric exchange-device-count" aria-label={`진행 중 ${moving}개`}>{moving}</span>}
          </button>;
        })}
      </div>
    </>}
  </div>;
}

function DeviceIcon({device}: {device: ExchangeDevice}) {
  return device.kind === 'pc' ? <ComputerDesktopIcon aria-hidden="true"/> : <DeviceTabletIcon aria-hidden="true"/>;
}

function Empty({title, text, limits}: {title: string; text: string; limits?: string[]}) {
  return <div className="exchange-empty">
    <span className="exchange-empty-glyph" aria-hidden="true"><ArrowsUpDownIcon/></span>
    <h2>{title}</h2>
    <p>{text}</p>
    {limits && <ul className="exchange-limits">{limits.map(limit => <li key={limit}>{limit}</li>)}</ul>}
  </div>;
}

function DaySeparator({at}: {at: string}) {
  const {date, note} = dayLabel(at);
  return <li className="exchange-day" aria-label={`${date} ${note}`}><span className="numeric">{date}</span>{note}</li>;
}

/** One send or arrival: a lone file, or a batch with its combined progress. */
function Block({block, peerName, actions}: {block: TimelineBlock<ExchangeRow>; peerName: string; actions: Actions}) {
  const rows = block.entries.map(entry => entry.row);
  const incoming = !block.mine;
  const progress = batchProgress(rows.map(batchPart));
  const moving = rows.some(row => ACTIVE_STATES.has(row.state) && !(incoming && row.state === 'waiting'));
  const failed = rows.some(row => rowView(row, incoming).tone === 'error');
  const delivered = block.mine && rows.every(row => row.state === 'delivered');
  const images = rows.length > 1 && rows.every(row => isImageName(row.fileName));
  const time = clockLabel(block.at);
  const who = <p className="exchange-who">
    {block.mine ? '나' : peerName}{time && <> · <time className="numeric" dateTime={block.at}>{time}</time></>}
    {incoming && rows.length > 1 && <> · 파일 <span className="numeric">{rows.length}</span>개</>}
    {delivered && <> · 전달됨<CheckIcon className="exchange-delivered" aria-hidden="true"/></>}
  </p>;
  const cancellable = rows.filter(row => rowView(row, incoming).actions.includes('cancel'));
  const current = rows.find(row => MOVING_NOW.has(row.state));
  // An arrival's own count is in the who line; a head is for sends and photo strips.
  const head = rows.length > 1 && (block.mine || images);
  return <li className="exchange-block" data-mine={block.mine}>
    {who}
    <div className="exchange-bubble" data-error={failed}>
      {head && <div className="exchange-batch-head">
        <strong>{images ? '사진' : '파일'} <span className="numeric">{rows.length}</span>개</strong>
        <span className="exchange-batch-meta numeric">{moving ? `${progress.finished}/${progress.total} · ${formatBytes(progress.done)} / ${formatBytes(progress.size)}` : formatBytes(progress.size)}</span>
        {moving && <span className="exchange-pct numeric">{progress.percent}%</span>}
      </div>}
      {head && moving && <div className="exchange-batch-bar"><Bar percent={progress.percent}/></div>}
      {images
        ? <>
            <ThumbStrip rows={rows} incoming={incoming} actions={actions}/>
            {rows.filter(row => rowView(row, incoming).tone === 'error').map(row => <FileRow key={row.transferId} row={row} incoming={incoming} actions={actions}/>)}
            {moving && <div className="exchange-batch-foot">
              <span>{current ? `${rowView(current, incoming).label} · ${current.fileName}` : incoming ? '받기 대기 중' : '보내는 중'}</span>
              {cancellable.length > 1 && <Button size="sm" variant="ghost" onClick={() => cancellable.forEach(row => actions.onCancel(row.transferId))}>{incoming ? '모두 받지 않기' : '모두 취소'}</Button>}
            </div>}
          </>
        : rows.map(row => <FileRow key={row.transferId} row={row} incoming={incoming} actions={actions}/>)}
    </div>
  </li>;
}

const MOVING_NOW = new Set(['zipping', 'preparing', 'uploading', 'completing', 'downloading', 'saving']);

function Bar({percent, striped}: {percent: number; striped?: boolean}) {
  return <span className="exchange-progress" data-striped={striped} aria-hidden="true"><span style={{width: `${percent}%`}}/></span>;
}

/** Files that exist on this device: sent originals and saved copies, never a pending arrival. */
const hasLocalFile = (row: ExchangeRow, incoming: boolean) => incoming ? row.state === 'saved' : row.state !== 'zipping';

function Glyph({row, incoming}: {row: ExchangeRow; incoming: boolean}) {
  const image = isImageName(row.fileName);
  const url = useExchangeThumbnail(row.transferId, image && hasLocalFile(row, incoming));
  return url
    ? <span className="exchange-glyph" data-image="true"><img src={url} alt=""/></span>
    : <span className="exchange-glyph" data-zip={/\.zip$/i.test(row.fileName)} aria-hidden="true">{extensionLabel(row.fileName)}</span>;
}

function FileRow({row, incoming, actions}: {row: ExchangeRow; incoming: boolean; actions: Actions}) {
  const view = rowView(row, incoming);
  const size = row.sizeBytes >= 0 ? formatBytes(row.sizeBytes) : '';
  const moving = view.progress !== null && view.tone === 'active' && row.state !== 'saving' && row.state !== 'completing';
  const bytes = moving && row.sizeBytes > 0 ? `${formatBytes(row.bytes)} / ${size}` : size;
  const label = row.state === 'saved' ? '저장됨' : view.label;
  const meta = [bytes, label, row.skipped ? `읽지 못한 항목 ${row.skipped}개 제외` : ''].filter(Boolean);
  const percent = view.progress !== null ? Math.floor(view.progress * 100) : 0;
  return <div className="exchange-row" data-state={row.state}>
    <Glyph row={row} incoming={incoming}/>
    <span className="exchange-row-text">
      <strong>{row.fileName}</strong>
      <span className="exchange-state" data-tone={view.tone}>
        {view.tone === 'error' && <ExclamationTriangleIcon aria-hidden="true"/>}
        {meta.map((part, index) => <Fragment key={index}>{index > 0 && ' · '}<span className={index === 0 ? 'numeric' : undefined}>{part}</span></Fragment>)}
      </span>
      {view.progress !== null && <Bar percent={view.progress * 100} striped={row.state === 'zipping'}/>}
    </span>
    {moving && <span className="exchange-pct numeric" aria-label={`${view.label} ${percent}%`}>{percent}%</span>}
    {view.actions.length > 0 && <span className="exchange-row-actions">
      {view.actions.includes('open') && <Button size="sm" aria-label={`${row.fileName} 열기`} onClick={() => actions.onOpen(row.transferId)}>열기</Button>}
      {view.actions.includes('retry') && <Button size="sm" onClick={() => actions.onRetry(row.transferId)}>재시도</Button>}
      {view.actions.includes('cancel') && <Button size="sm" variant="ghost" onClick={() => actions.onCancel(row.transferId)}>{incoming ? '받지 않기' : '취소'}</Button>}
    </span>}
  </div>;
}

/** Up to six thumbnails with a done mark, the current file's own bar and "+N". */
function ThumbStrip({rows, incoming, actions}: {rows: ExchangeRow[]; incoming: boolean; actions: Actions}) {
  const shown = rows.slice(0, 6);
  const more = rows.length - shown.length;
  return <div className="exchange-strip">
    {shown.map((row, index) => {
      const view = rowView(row, incoming);
      const last = index === shown.length - 1 && more > 0;
      const label = `${row.fileName}, ${row.state === 'saved' ? '저장됨' : view.label}`;
      const tile = <>
        <StripImage row={row} incoming={incoming}/>
        {batchPart(row).finished && <span className="exchange-strip-done" aria-hidden="true"><CheckIcon/></span>}
        {MOVING_NOW.has(row.state) && view.progress !== null && <span className="exchange-strip-bar"><Bar percent={view.progress * 100}/></span>}
        {last && <span className="exchange-strip-more numeric" aria-hidden="true">+{more}</span>}
      </>;
      const waiting = !batchPart(row).finished && !MOVING_NOW.has(row.state);
      return view.actions.includes('open') && !last
        ? <button key={row.transferId} type="button" className="exchange-strip-tile" aria-label={`${label}, 열기`} onClick={() => actions.onOpen(row.transferId)}>{tile}</button>
        : <span key={row.transferId} className="exchange-strip-tile" data-waiting={waiting} role="img" aria-label={last ? `${label} 외 ${more}개` : label}>{tile}</span>;
    })}
  </div>;
}

function StripImage({row, incoming}: {row: ExchangeRow; incoming: boolean}) {
  const url = useExchangeThumbnail(row.transferId, hasLocalFile(row, incoming));
  return url ? <img src={url} alt=""/> : <span className="exchange-strip-ext" aria-hidden="true">{extensionLabel(row.fileName)}</span>;
}
