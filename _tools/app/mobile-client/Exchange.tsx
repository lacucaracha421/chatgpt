import {useEffect, useState, type MutableRefObject} from 'react';
import {ArrowLeftIcon, ArrowUpTrayIcon, ComputerDesktopIcon, DocumentIcon, DeviceTabletIcon, FolderIcon} from '@heroicons/react/24/outline';
import {Button, IconButton} from './ui';
import {errorText, native} from './transport';
import {formatBytes} from './libraryTrash';
import {
  defaultTarget, errorCode, EXCHANGE_NOTICE_EVENT, rowView, screenMessage, TOKEN_CODES,
  type ExchangeRow, type ExchangeSnapshot,
} from './exchange';
import './exchange.css';

/**
 * 보내기/받기: send files to another registered device and see what arrived. Arrivals save
 * themselves into Download/Lakomics while the app is open; this screen only shows them.
 * While it is open, native refreshes the inbox and outbox every 5 s.
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
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    backRef.current = () => { if (editingToken) { setEditingToken(false); return true; } onClose(); return true; };
    return () => { backRef.current = null; };
  }, [backRef, onClose, editingToken]);

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
  const open = (transferId: string) => { setNotice(''); void native('exchangeOpen', {transferId}).catch(reason => setNotice(errorText(reason))); };
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

  const incoming = snapshot?.incoming ?? [];
  const outgoing = snapshot?.outgoing ?? [];
  return <div className="exchange-overlay" role="dialog" aria-modal="true" aria-label="보내기/받기">
    <header className="exchange-bar">
      <IconButton label="보내기/받기 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="exchange-title"><h1>보내기/받기</h1>{snapshot?.deviceName && <p>{snapshot.deviceName}</p>}</div>
    </header>
    <div className="exchange-scroll">
      {!snapshot && <div className="loading-line" role="status" aria-label="보내기/받기 불러오는 중"/>}
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

      {usable && <section className="exchange-section" aria-label="보내기">
        <h2>보내기</h2>
        {devices.length === 0 ? <p className="hint">받을 기기가 없습니다. PC의 Lakomics에서 보내기/받기를 한 번 열면 여기에 나타납니다.</p> : <>
          {devices.length > 1 && <div className="exchange-targets" role="radiogroup" aria-label="받는 기기">
            {devices.map(device => <button key={device.deviceId} type="button" role="radio" aria-checked={device.deviceId === target?.deviceId} className="exchange-target" onClick={() => setChosen(device.deviceId)}>
              {device.kind === 'pc' ? <ComputerDesktopIcon aria-hidden="true"/> : <DeviceTabletIcon aria-hidden="true"/>}{device.name}
            </button>)}
          </div>}
          <div className="exchange-send-actions">
            <Button variant="primary" className="exchange-send" onClick={() => send('exchangeSend')} disabled={!target}><ArrowUpTrayIcon aria-hidden="true"/>{target ? `${target.name}(으)로 파일 보내기` : '파일 보내기'}</Button>
            <Button className="exchange-send" onClick={() => send('exchangeSendFolder')} disabled={!target}><FolderIcon aria-hidden="true"/>폴더 보내기</Button>
          </div>
          <p className="hint">파일당 최대 2GB · 폴더는 zip 파일 하나로 압축해 보냅니다 · 받으면 서버에서 바로 삭제되고, 받지 않으면 24시간 뒤 삭제됩니다. 다른 앱의 공유 메뉴에서 Lakomics를 골라도 보낼 수 있습니다.</p>
        </>}
      </section>}

      {usable && snapshot.receiveSupported && <section className="exchange-section" aria-label="받은 파일">
        <h2>받은 파일</h2>
        <p className="hint">앱이 열려 있을 때 자동으로 다운로드/Lakomics 폴더에 저장됩니다.</p>
        {incoming.length ? <ul className="exchange-list">{incoming.map(row => <Row key={row.transferId} row={row} incoming onOpen={open} onRetry={id => run('exchangeRetry', id)} onCancel={id => run('exchangeCancel', id)}/>)}</ul>
          : <p className="exchange-empty">아직 받은 파일이 없습니다.</p>}
      </section>}
      {usable && !snapshot.receiveSupported && <p className="hint exchange-notice">이 Android 버전에서는 받기를 지원하지 않습니다 (Android 10 이상 필요). 보내기는 사용할 수 있습니다.</p>}

      {usable && <section className="exchange-section" aria-label="보낸 파일">
        <h2>보낸 파일</h2>
        {outgoing.length ? <ul className="exchange-list">{outgoing.map(row => <Row key={row.transferId} row={row} incoming={false} onOpen={open} onRetry={id => run('exchangeRetry', id)} onCancel={id => run('exchangeCancel', id)}/>)}</ul>
          : <p className="exchange-empty">최근 7일 동안 보낸 파일이 없습니다.</p>}
      </section>}

      {snapshot?.configured && snapshot.tokenConfigured && !showToken && <div className="exchange-foot"><Button variant="ghost" onClick={() => setEditingToken(true)}>기기 토큰 변경</Button></div>}
    </div>
  </div>;
}

function Row({row, incoming, onOpen, onRetry, onCancel}: {row: ExchangeRow; incoming: boolean; onOpen(id: string): void; onRetry(id: string): void; onCancel(id: string): void}) {
  const view = rowView(row, incoming);
  const size = row.sizeBytes >= 0 ? formatBytes(row.sizeBytes) : '';
  const meta = [size, row.peer && (incoming ? `${row.peer}에서` : `${row.peer}(으)로`), row.skipped ? `읽지 못한 항목 ${row.skipped}개 제외` : ''].filter(Boolean).join(' · ');
  const body = <>
    <DocumentIcon className="exchange-file-icon" aria-hidden="true"/>
    <span className="exchange-row-text">
      <strong>{row.fileName}</strong>
      <span className="exchange-meta numeric">{meta}</span>
      <span className="exchange-state" data-tone={view.tone}>{view.label}{view.progress !== null && view.tone === 'active' && row.state !== 'saving' && row.state !== 'completing' ? ` ${Math.floor(view.progress * 100)}%` : ''}</span>
      {view.progress !== null && <span className="exchange-progress" aria-hidden="true"><span style={{width: `${view.progress * 100}%`}}/></span>}
    </span>
  </>;
  return <li className="exchange-row" data-state={row.state}>
    {view.actions.includes('open')
      ? <button type="button" className="exchange-row-main" aria-label={`${row.fileName}, ${view.label}, 열기`} onClick={() => onOpen(row.transferId)}>{body}</button>
      : <div className="exchange-row-main">{body}</div>}
    {(view.actions.includes('retry') || view.actions.includes('cancel')) && <span className="exchange-row-actions">
      {view.actions.includes('retry') && <Button size="sm" variant="ghost" onClick={() => onRetry(row.transferId)}>재시도</Button>}
      {view.actions.includes('cancel') && <Button size="sm" variant="ghost" onClick={() => onCancel(row.transferId)}>{incoming ? '받지 않기' : '취소'}</Button>}
    </span>}
  </li>;
}
