import {useEffect, useState} from 'react';
import {XMarkIcon, ArrowTopRightOnSquareIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription, IconButton} from './ui';
import {errorText, native} from './transport';
import type {Status} from './types';
import {PickerSettings} from './PickerSettings';
import {onWarmState, setWarmEnabled, warmEnabled, warmState, type WarmState} from './thumbnailWarm';
import './Settings.css';

type CacheStatus = {bytes:number; count:number; limit:number};
const APP_VERSION = '0.8.30';

export function Settings({status, onStatus, onClose, onCacheCleared, onOpenVault}: {status: Status; onStatus(status: Status): void; onClose(): void; onCacheCleared():void; onOpenVault?():void}) {
  const [endpoint, setEndpoint] = useState(status.endpoint);
  const [token, setToken] = useState('');
  const [privateHttp, setPrivateHttp] = useState(status.allowPrivateHttp ?? false);
  const [editing, setEditing] = useState(!status.configured);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [cache, setCache] = useState<CacheStatus>(), [cacheBusy,setCacheBusy] = useState(false), [cacheMessage,setCacheMessage] = useState('');
  useEffect(() => {
    const controller=new AbortController();
    void native<CacheStatus>('cacheStatus',{},controller.signal).then(setCache).catch(reason => {if(!controller.signal.aborted)setCacheMessage(errorText(reason));});
    return () => controller.abort();
  }, []);
  const connect = () => {
    setBusy(true); setError('');
    void native<Status>('configure', {endpoint:endpoint.trim(), token:token.trim(), allowPrivateHttp:privateHttp}).then(result => {
      setToken(''); setEditing(false); onStatus(result); onClose();
    }).catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
  };
  return <Dialog open title="연결 및 설정" onClose={onClose}>
    <header className="dialog-header"><span className="eyebrow">LAKOMICS / CONNECTION</span><IconButton label="설정 닫기" icon={XMarkIcon} onClick={onClose}/></header>
    {/* Radix requires a description on the content; the visible row states it already. */}
    <DialogDescription className="sr-only">연결 상태, 미디어 캐시와 파일 선택기 설정을 관리합니다.</DialogDescription>
    <section className="settings-section" aria-label="현재 연결">
      <p className="settings-connection"><span className="status-dot"/>{status.configured?'클라우드 연결됨':'연결되지 않음'}<span className="numeric muted">{status.endpoint || '주소 없음'}</span></p>
      {status.configured && <div className="settings-inline-actions">
        <Button variant="ghost" onClick={() => setEditing(value => !value)} aria-expanded={editing}>{editing ? '연결 변경 취소' : '연결 변경'}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => {
          setBusy(true); setError('');
          void native<Status>('disconnect').then(result => {onStatus(result); setEditing(true); onClose();}).catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
        }}>연결 해제</Button>
      </div>}
      {!status.configured && <p className="settings-intro">PC에서 설정한 서버 주소와 기기 토큰으로 연결합니다. 라이브러리와 파일 선택기가 같은 연결을 사용합니다.</p>}
      {editing && <form className="settings-connection-form" onSubmit={event => {event.preventDefault(); connect();}}>
        <label className="field">서버 주소<input type="url" required value={endpoint} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://your-server.example" onChange={event => setEndpoint(event.target.value)}/></label>
        <label className="field">기기 토큰<input type="password" required value={token} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => setToken(event.target.value)}/></label>
        <label className="check-field"><input type="checkbox" checked={privateHttp} onChange={event => setPrivateHttp(event.target.checked)}/>개인 네트워크의 HTTP 연결 허용</label>
        {privateHttp && <p className="hint">Tailscale·내부망의 숫자 IP 주소에만 사용하세요. 일반 인터넷 주소는 HTTPS가 필요합니다.</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="dialog-actions"><Button variant="primary" type="submit" disabled={busy}>{busy ? '연결 확인 중' : '연결 확인하고 저장'}</Button></div>
      </form>}
      {!editing && error && <p className="error-message" role="alert">{error}</p>}
    </section>
    <section className="settings-section" aria-label="미디어 캐시">
      <div className="settings-section-head"><h3>미디어 캐시</h3><span className="numeric">{cache ? `${(cache.bytes/1024/1024).toFixed(1)} MB / ${(cache.limit/1024/1024/1024).toFixed(0)} GB · ${cache.count}개` : '사용량 확인 중…'}</span></div>
      <div className="settings-inline-actions"><Button variant="ghost" disabled={busy || cacheBusy || !cache} onClick={() => {
        setCacheBusy(true); setCacheMessage('');
        void native<CacheStatus>('clearCache').then(result => {setCache(result);onCacheCleared();setCacheMessage('미디어 캐시를 지웠습니다.');}).catch(reason => setCacheMessage(errorText(reason))).finally(() => setCacheBusy(false));
      }}>{cacheBusy ? '지우는 중…' : '캐시 지우기'}</Button></div>
      {cacheMessage && <p role="status">{cacheMessage}</p>}
      <ThumbnailWarmSetting/>
    </section>
    {onOpenVault && <section className="settings-section" aria-label="비밀 보관함"><Button onClick={onOpenVault}>비밀 보관함</Button><p className="hint">USB를 연결해 이미지와 영상을 감상합니다.</p></section>}
    <PickerSettings configured={status.configured}/>
    <details className="settings-advanced">
      <summary>연결·캐시 동작 자세히</summary>
      <p>썸네일과 감상한 이미지, 다른 앱에 첨부한 파일을 함께 저장합니다. 최대 1GB 안에서 오래 사용하지 않은 항목부터 정리하며, 1년 동안 보지 않은 파일도 삭제합니다. 썸네일 미리 받기는 앱이 켜져 있고 모바일 데이터가 아닐 때 전체 썸네일을 차례로 받아 둡니다.</p>
      <p>캐시 지우기는 이 기기에 저장된 미디어 사본만 삭제합니다. 서버의 원본과 연결 정보, 분류·앨범 구성은 그대로 유지됩니다.</p>
      <p>연결 해제는 기기에 저장된 서버 주소와 토큰을 지웁니다. 다시 사용하려면 주소와 토큰을 입력해야 합니다.</p>
    </details>
    <div className="settings-foot"><span>{APP_VERSION} · Android</span><Button variant="ghost" onClick={() => {void native('openExternal', {url:'https://github.com/lacucaracha421/chatgpt'}).catch(reason => setError(errorText(reason)));}}><ArrowTopRightOnSquareIcon/>프로젝트</Button></div>
  </Dialog>;
}

const warmLabels:Record<WarmState['status'],string>={off:'꺼짐',waiting:'앱을 다시 열면 이어서 받습니다',running:'받는 중',metered:'모바일 데이터에서는 멈춥니다',done:'모두 받아 두었습니다',error:'잠시 후 다시 시도합니다'};
/** Library-wide thumbnail warm-up switch and its live progress. */
function ThumbnailWarmSetting() {
  const [enabled,setEnabled]=useState(warmEnabled),[state,setState]=useState(warmState);
  useEffect(()=>onWarmState(setState),[]);
  return <div className="settings-warm">
    <label><input type="checkbox" checked={enabled} onChange={event=>{setEnabled(event.target.checked);setWarmEnabled(event.target.checked);}}/>썸네일 미리 받기</label>
    <span className="muted" role="status">{enabled?`${warmLabels[state.status]} · 확인한 썸네일 ${state.warmed.toLocaleString()}장`:warmLabels.off}</span>
  </div>;
}
