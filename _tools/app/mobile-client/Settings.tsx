import { useDelayedBusy } from "../src/shared/useDelayedBusy";
import { BusyLabel } from "../src/shared/ui/BusyLabel";
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Button, Field, SegmentedControl, SettingsGroup, SettingsRow, Switch, TextInput} from './ui';
import {TopBar} from './TopBar';
import {errorText, native} from './transport';
import type {Status} from './types';
import {onWarmState, setWarmEnabled, warmEnabled, warmState, type WarmState} from './thumbnailWarm';
import {useNsfwFilter,usePrivacyMode} from './privacyMode';
import {useCaseSounds} from '../src/preferences/caseSoundPreference';
import {SETTINGS_SECTION_LABELS} from '../src/shared/findEntries';
import {prefersReducedMotion} from '../src/shared/motion/curves';
import type {TabletSettingsSection} from './findData';
import './Settings.css';

type CacheStatus = {bytes:number; count:number; limit:number};
declare const __APP_VERSION__: string | undefined;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export function Settings({status, onStatus, onClose, onCacheCleared, onOpenVault, section}: {status: Status; onStatus(status: Status): void; onClose(): void; onCacheCleared():void; /** Only until a vault USB has been chosen; afterwards Home shows the vault icon. */ onOpenVault?():void;
  /** A 찾기 "설정 › …" pick: that group is scrolled into view (at once when Settings opens with it). */ section?:{id:TabletSettingsSection;request:number}|null}) {
  const [endpoint, setEndpoint] = useState(status.endpoint);
  const [token, setToken] = useState('');
  const [privateHttp, setPrivateHttp] = useState(status.allowPrivateHttp ?? false);
  const [nsfwFilter,setNsfwFilter]=useNsfwFilter();
  const [privacyMode, setPrivacyMode] = usePrivacyMode();
  const [caseSounds, setCaseSounds] = useCaseSounds();
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

  const scroller = useRef<HTMLElement>(null), opened = useRef(false);
  useLayoutEffect(() => {
    if (!section) return;
    const group = scroller.current?.querySelector(`[aria-labelledby="settings-group-${SETTINGS_SECTION_LABELS[section.id]}"]`);
    group?.scrollIntoView?.({block:'start', behavior:opened.current && !prefersReducedMotion() ? 'smooth' : 'auto'});
    opened.current = true;
  }, [section?.id, section?.request]);

  const showCacheCheck = useDelayedBusy(!cache);
  const cacheValue = showCacheCheck ? '사용량 확인 중…' : cache ? `${(cache.bytes/1024/1024).toFixed(1)} MB / ${(cache.limit/1024/1024/1024).toFixed(0)} GB · ${(cache.count ?? 0).toLocaleString('ko-KR')}개` : '';

  return <div className="settings-screen">
    <TopBar back={{label:'홈으로', onClick:onClose}} title="설정" />
    <main ref={scroller} className="settings-screen__scroll" aria-label="설정 항목">
      <div className="settings-screen__content">
        <SettingsGroup title={SETTINGS_SECTION_LABELS.connection}>
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

        <SettingsGroup title={SETTINGS_SECTION_LABELS.display}>
          <TextZoomSetting/>
          <SettingsRow name="비공개 모드" control={<Switch aria-label="비공개 모드" checked={privacyMode} onChange={event => setPrivacyMode(event.target.checked)} />} />
          <SettingsRow name="NSFW 필터" status="전연령 이미지만 보여요" control={<Switch aria-label="NSFW 필터" checked={nsfwFilter} onChange={event => setNsfwFilter(event.target.checked)} />} />
          <SettingsRow name="케이스 소리" status="컬렉션에서 케이스와 책을 열고 닫을 때" control={<Switch aria-label="케이스 소리" checked={caseSounds} onChange={event => setCaseSounds(event.target.checked)} />} />
        </SettingsGroup>

        <SettingsGroup title={SETTINGS_SECTION_LABELS.storage}>
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

        {onOpenVault && <SettingsGroup title={SETTINGS_SECTION_LABELS.vault}>
          <SettingsRow name="비밀 보관함" control={<Button variant="quiet" type="button" onClick={onOpenVault}>연결</Button>} />
        </SettingsGroup>}

        <SettingsGroup title="정보">
          <SettingsRow name="버전" value={`${APP_VERSION} · Android`} />
        </SettingsGroup>
      </div>
    </main>
  </div>;
}

const TEXT_ZOOM_OPTIONS=[{value:'0',label:'시스템'},...[90,100,110,125,150].map(level=>({value:String(level),label:`${level}%`}))] as const;

/**
 * 글자 크기 (PC: 화면 배율): the app's WebView text zoom, kept by Android on this device and applied
 * before the page paints. Only text grows or shrinks, so layout, 44 px touch targets and the viewers'
 * own pinch zoom stay as they are. Absent on an app build without the native setting.
 */
function TextZoomSetting() {
  const bridge=typeof window.LakomicsNative?.textZoom==='function'&&typeof window.LakomicsNative.setTextZoom==='function'?window.LakomicsNative:null;
  const [value,setValue]=useState(()=>{try{return String(bridge?.textZoom?.()??0);}catch{return '0';}});
  const [failed,setFailed]=useState(false);
  if(!bridge)return null;
  const shown=TEXT_ZOOM_OPTIONS.some(option=>option.value===value)?value:'0';
  return <SettingsRow name="글자 크기" status={failed?'바꾸지 못했습니다. 다시 시도해 주세요.':'사진과 뷰어의 확대는 그대로예요'} tone={failed?'off':undefined}
    control={<SegmentedControl label="글자 크기" value={shown} options={TEXT_ZOOM_OPTIONS} onChange={next=>{
      let saved=false;try{saved=bridge.setTextZoom?.(Number(next))===true;}catch{/* reported below */}
      setFailed(!saved);if(saved)setValue(next);
    }}/>}/>;
}

const warmLabels:Record<WarmState['status'],string>={off:'꺼짐',waiting:'앱을 다시 열면 이어서 받습니다',running:'받는 중',metered:'모바일 데이터에서는 멈춥니다',done:'모두 받아 두었습니다',error:'잠시 후 다시 시도합니다'};

/** Library-wide thumbnail warm-up switch and its live progress. */
function ThumbnailWarmSetting() {
  const [enabled,setEnabled]=useState(warmEnabled),[state,setState]=useState(warmState);
  useEffect(()=>onWarmState(setState),[]);
  const status = enabled ? `${warmLabels[state.status]} · 확인한 썸네일 ${state.warmed.toLocaleString('ko-KR')}장` : warmLabels.off;
  return <SettingsRow name="썸네일 미리 받기" status={<BusyLabel busy={enabled&&state.status==='running'} idle={enabled&&state.status==='running'?null:status}>{status}</BusyLabel>} control={<Switch aria-label="썸네일 미리 받기" checked={enabled} onChange={event=>{setEnabled(event.target.checked);setWarmEnabled(event.target.checked);}}/>}/>;
}
