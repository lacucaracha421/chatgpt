import {useEffect, useState} from 'react';
import {XMarkIcon, ArrowTopRightOnSquareIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription, IconButton} from './ui';
import {errorText, native} from './transport';
import type {Status} from './types';
import {PickerSettings} from './PickerSettings';

type CacheStatus = {bytes:number; count:number; limit:number};
export function Settings({status, onStatus, onClose, onCacheCleared}: {status: Status; onStatus(status: Status): void; onClose(): void; onCacheCleared():void}) {
  const [endpoint, setEndpoint] = useState(status.endpoint);
  const [token, setToken] = useState('');
  const [privateHttp, setPrivateHttp] = useState(status.allowPrivateHttp ?? false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [cache, setCache] = useState<CacheStatus>(), [cacheBusy,setCacheBusy] = useState(false), [cacheMessage,setCacheMessage] = useState('');
  useEffect(() => {
    const controller=new AbortController();
    void native<CacheStatus>('cacheStatus',{},controller.signal).then(setCache).catch(reason => {if(!controller.signal.aborted)setCacheMessage(errorText(reason));});
    return () => controller.abort();
  }, []);
  return <Dialog open title="연결 및 설정" onClose={onClose}>
    <header className="dialog-header"><span className="eyebrow">LAKOMICS / CONNECTION</span><IconButton label="설정 닫기" icon={XMarkIcon} onClick={onClose}/></header>
    <DialogDescription className="dialog-description">PC에서 설정한 서버 주소와 기기 토큰으로 연결합니다. 라이브러리와 파일 선택기가 같은 연결을 사용합니다.</DialogDescription>
    <p className="settings-connection"><span className="status-dot"/>{status.configured?'클라우드 연결됨':'연결되지 않음'}</p>
    <form onSubmit={event => {
      event.preventDefault(); setBusy(true); setError('');
      void native<Status>('configure', {endpoint:endpoint.trim(), token:token.trim(), allowPrivateHttp:privateHttp}).then(result => {
        setToken(''); onStatus(result); onClose();
      }).catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
    }}>
      <label className="field">서버 주소<input type="url" required value={endpoint} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://your-server.example" onChange={event => setEndpoint(event.target.value)}/></label>
      <label className="field">기기 토큰<input type="password" required value={token} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => setToken(event.target.value)}/></label>
      <label className="check-field"><input type="checkbox" checked={privateHttp} onChange={event => setPrivateHttp(event.target.checked)}/>개인 네트워크의 HTTP 연결 허용</label>
      {privateHttp && <p className="hint">Tailscale·내부망의 숫자 IP 주소에만 사용하세요. 일반 인터넷 주소는 HTTPS가 필요합니다.</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="dialog-actions"><Button variant="primary" type="submit" disabled={busy}>{busy ? '연결 확인 중' : '연결 확인하고 저장'}</Button>
        {status.configured && <Button type="button" disabled={busy} onClick={() => {
          setBusy(true); void native<Status>('disconnect').then(result => {onStatus(result); onClose();}).catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
        }}>연결 해제</Button>}
      </div>
    </form>
    <section className="settings-note"><h3>미디어 캐시</h3><p>썸네일과 감상한 이미지, 다른 앱에 첨부한 파일을 함께 저장합니다. 최대 1GB 안에서 오래 사용하지 않은 항목부터 정리하며, 7일 동안 보지 않은 파일도 삭제합니다.</p>
      <div className="cache-controls"><span className="numeric">{cache ? `${(cache.bytes/1024/1024).toFixed(1)} MB / ${(cache.limit/1024/1024/1024).toFixed(0)} GB · ${cache.count}개` : '사용량 확인 중…'}</span>
      <Button variant="ghost" disabled={busy || cacheBusy || !cache} onClick={() => {
        setCacheBusy(true); setCacheMessage('');
        void native<CacheStatus>('clearCache').then(result => {setCache(result);onCacheCleared();setCacheMessage('미디어 캐시를 지웠습니다.');}).catch(reason => setCacheMessage(errorText(reason))).finally(() => setCacheBusy(false));
      }}>{cacheBusy ? '지우는 중…' : '캐시 지우기'}</Button></div><p className="hint">서버의 원본과 연결 정보는 유지됩니다.</p>{cacheMessage && <p role="status">{cacheMessage}</p>}
    </section>
    <PickerSettings configured={status.configured}/>
    <div className="settings-foot"><span>0.6.2 · Android</span><Button variant="ghost" onClick={() => {void native('openExternal', {url:'https://github.com/lacucaracha421/chatgpt'}).catch(reason => setError(errorText(reason)));}}><ArrowTopRightOnSquareIcon/>프로젝트</Button></div>
  </Dialog>;
}
