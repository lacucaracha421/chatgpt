import { useDelayedBusy } from "../src/shared/useDelayedBusy";
import { BusyLabel } from "../src/shared/ui/BusyLabel";
import {useEffect, useState} from 'react';
import {Button, Field, SettingsGroup, SettingsRow, Switch, TextInput} from './ui';
import {TopBar} from './TopBar';
import {errorText, native} from './transport';
import type {Status} from './types';
import {onWarmState, setWarmEnabled, warmEnabled, warmState, type WarmState} from './thumbnailWarm';
import {useNsfwFilter,usePrivacyMode} from './privacyMode';
import './Settings.css';

type CacheStatus = {bytes:number; count:number; limit:number};
declare const __APP_VERSION__: string | undefined;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export function Settings({status, onStatus, onClose, onCacheCleared, onOpenVault}: {status: Status; onStatus(status: Status): void; onClose(): void; onCacheCleared():void; /** Only until a vault USB has been chosen; afterwards Home shows the vault icon. */ onOpenVault?():void}) {
  const [endpoint, setEndpoint] = useState(status.endpoint);
  const [token, setToken] = useState('');
  const [privateHttp, setPrivateHttp] = useState(status.allowPrivateHttp ?? false);
  const [nsfwFilter,setNsfwFilter]=useNsfwFilter();
  const [privacyMode, setPrivacyMode] = usePrivacyMode();
  const [editing, setEditing] = useState(!status.configured);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [cache, setCache] = useState<CacheStatus>(), [cacheBusy,setCacheBusy] = useState(false), [cacheMessage,setCacheMessage] = useState('');
  const [cacheMessageTone, setCacheMessageTone] = useState<'ok'|'off'|undefined>();

  useEffect(() => {
    const controller=new AbortController();
    void native<CacheStatus>('cacheStatus',{},controller.signal).then(setCache).catch(reason => {
      if(!controller.signal.aborted) {
        setCacheMessage(errorText(reason));
        setCacheMessageTone('off');
      }
    });
    return () => controller.abort();
  }, []);

  const connect = () => {
    setBusy(true); setError('');
    void native<Status>('configure', {endpoint:endpoint.trim(), token:token.trim(), allowPrivateHttp:privateHttp}).then(result => {
      setToken(''); setEditing(false); onStatus(result); onClose();
    }).catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
  };

  const showCacheCheck = useDelayedBusy(!cache);
  const cacheValue = showCacheCheck ? '사용량 확인 중…' : cache ? `${(cache.bytes/1024/1024).toFixed(1)} MB / ${(cache.limit/1024/1024/1024).toFixed(0)} GB · ${(cache.count ?? 0).toLocaleString('ko-KR')}개` : '';

  return <div className="settings-screen">
    <TopBar find back={{label:'홈으로', onClick:onClose}} title="설정" />
    <main className="settings-screen__scroll" aria-label="설정 항목">
      <div className="settings-screen__content">
        <SettingsGroup title="연결">
          <SettingsRow
            name="서버"
            value={status.endpoint || '주소 없음'}
            status={status.configured ? '연결됨' : '연결 안 됨'}
            tone={status.configured ? 'ok' : 'off'}
            control={status.configured ? <span className="settings-view__control-pair">
              <Button variant="quiet" type="button" aria-expanded={editing} onClick={() => setEditing(value => !value)}>{editing ? '연결 변경 취소' : '연결 변경'}</Button>
              <Button variant="quiet" type="button" disabled={busy} onClick={() => {
                setBusy(true); setError('');
                void native<Status>('disconnect').then(result => {onStatus(result); setEditing(true); onClose();}).catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
              }}>연결 해제</Button>
            </span> : undefined}
          />
          {editing && <form className="settings-screen__inline-edit" onSubmit={event => {event.preventDefault(); connect();}}>
            <div className="settings-screen__form-fields">
              <Field label="서버 주소">
                <TextInput type="url" required value={endpoint} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://your-server.example" onChange={event => setEndpoint(event.target.value)} />
              </Field>
              <Field label="기기 토큰">
                <TextInput type="password" required value={token} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => setToken(event.target.value)} />
              </Field>
            </div>
            <Switch label="개인 네트워크 HTTP 허용" checked={privateHttp} onChange={event => setPrivateHttp(event.target.checked)} />
            {privateHttp && <p className="settings-screen__safety-line">숫자 IP(Tailscale·내부망)에만 사용</p>}
            {error && <p className="settings-screen__error" role="alert">{error}</p>}
            <div className="settings-screen__form-actions"><Button variant="primary" type="submit" disabled={busy}><BusyLabel busy={!!(busy)} idle={'연결 확인하고 저장'}>연결 확인 중</BusyLabel></Button></div>
          </form>}
          {!editing && error && <p className="settings-screen__error" role="alert">{error}</p>}
        </SettingsGroup>

        <SettingsGroup title="화면">
          <SettingsRow name="비공개 모드" control={<Switch aria-label="비공개 모드" checked={privacyMode} onChange={event => setPrivacyMode(event.target.checked)} />} />
          <SettingsRow name="NSFW 필터" status="전연령 이미지만 보여요" control={<Switch aria-label="NSFW 필터" checked={nsfwFilter} onChange={event => setNsfwFilter(event.target.checked)} />} />
        </SettingsGroup>

        <SettingsGroup title="저장 공간">
          <SettingsRow
            name="미디어 캐시"
            value={cacheValue}
            status={cacheMessage || undefined}
            tone={cacheMessageTone}
            control={<Button variant="quiet" type="button" disabled={busy || cacheBusy || !cache} onClick={() => {
              setCacheBusy(true); setCacheMessage(''); setCacheMessageTone(undefined);
              void native<CacheStatus>('clearCache').then(result => {setCache(result);onCacheCleared();setCacheMessage('미디어 캐시를 지웠습니다.');setCacheMessageTone('ok');}).catch(reason => {setCacheMessage(errorText(reason));setCacheMessageTone('off');}).finally(() => setCacheBusy(false));
            }}><BusyLabel busy={!!(cacheBusy)} idle={'캐시 지우기'}>지우는 중…</BusyLabel></Button>}
          />
          <ThumbnailWarmSetting/>
        </SettingsGroup>

        {onOpenVault && <SettingsGroup title="보관함">
          <SettingsRow name="비밀 보관함" control={<Button variant="quiet" type="button" onClick={onOpenVault}>연결</Button>} />
        </SettingsGroup>}

        <SettingsGroup title="정보">
          <SettingsRow name="버전" value={`${APP_VERSION} · Android`} />
        </SettingsGroup>
      </div>
    </main>
  </div>;
}

const warmLabels:Record<WarmState['status'],string>={off:'꺼짐',waiting:'앱을 다시 열면 이어서 받습니다',running:'받는 중',metered:'모바일 데이터에서는 멈춥니다',done:'모두 받아 두었습니다',error:'잠시 후 다시 시도합니다'};

/** Library-wide thumbnail warm-up switch and its live progress. */
function ThumbnailWarmSetting() {
  const [enabled,setEnabled]=useState(warmEnabled),[state,setState]=useState(warmState);
  useEffect(()=>onWarmState(setState),[]);
  const status = enabled ? `${warmLabels[state.status]} · 확인한 썸네일 ${state.warmed.toLocaleString('ko-KR')}장` : warmLabels.off;
  return <SettingsRow name="썸네일 미리 받기" status={<BusyLabel busy={enabled&&state.status==='running'} idle={enabled&&state.status==='running'?null:status}>{status}</BusyLabel>} control={<Switch aria-label="썸네일 미리 받기" checked={enabled} onChange={event=>{setEnabled(event.target.checked);setWarmEnabled(event.target.checked);}}/>}/>;
}
