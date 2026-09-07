import {useEffect, useState} from 'react';
import {Button} from './ui';
import {errorText, native} from './transport';
type PickerStatus = {supported:boolean; eligible?:boolean; selected?:boolean; syncing:boolean; scanned:number; mediaCount:number; albumCount:number; ready:boolean; lastSyncedAt:number; error:string};
export function PickerSettings({configured}:{configured:boolean}) {
  const [status,setStatus] = useState<PickerStatus>();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let timer:ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {const result=await native<PickerStatus>('pickerStatus',{},controller.signal);if (!controller.signal.aborted) {setStatus(result);timer=setTimeout(() => void poll(),result.syncing?2000:10000);}}
      catch (reason) {if (!controller.signal.aborted) setError(errorText(reason));}
    };
    void poll();return () => {controller.abort();clearTimeout(timer);};
  },[configured]);
  return <section className="settings-note"><h3>다른 앱에서 첨부하기</h3>
    <p>커뮤니티의 첨부 화면에서 <strong>파일 → Lakomics</strong>를 열면 분류 폴더 안의 이미지와 영상을 고를 수 있습니다.</p>
    {status?.supported && <>
      <p>사진 선택기에서는 Lakomics를 클라우드 미디어 앱으로 선택한 뒤 <strong>컬렉션</strong>을 열어 보세요. 분류 경로가 앨범 이름으로 표시됩니다.</p>
      <p role="status">{status.syncing ? `앨범 준비 중 · ${status.scanned.toLocaleString()}개 확인` : status.ready ? `준비된 미디어 ${status.mediaCount.toLocaleString()}개 · 분류 ${status.albumCount.toLocaleString()}개` : '아직 준비된 앨범이 없습니다.'}
        {status.selected ? ' · 사진 선택기에 연결됨' : status.eligible === false ? ' · 이 기기에서 공급자 등록이 필요합니다.' : ' · 사진 선택기에서 Lakomics를 선택해 주세요.'}</p>
      <div className="dialog-actions"><Button disabled={!configured || busy || status.syncing} onClick={() => {setBusy(true);setError('');void native<PickerStatus>('pickerRefresh').then(setStatus).catch(reason => setError(errorText(reason))).finally(() => setBusy(false));}}>{status.syncing ? '앨범 갱신 중' : '앨범 새로고침'}</Button>
        <Button variant="ghost" onClick={() => {void native('openPickerSettings').catch(() => setError('첨부 화면의 사진 선택기 메뉴에서 클라우드 미디어 앱 설정을 열어 주세요.'));}}>사진 선택기 설정</Button></div>
      {!!status.lastSyncedAt && <p className="hint">마지막 갱신 {new Date(status.lastSyncedAt).toLocaleString('ko-KR')}</p>}
      {status.error && <p role="status">앨범을 갱신하지 못했습니다. 이전 목록은 유지됩니다. 연결을 확인하고 다시 시도해 주세요.</p>}
      <p className="hint">처음에는 목록을 준비할 시간이 필요합니다. 기존 Pick 앱의 수동 앨범 설정은 자동으로 옮겨지지 않습니다.</p>
    </>}
    {error && <p role="status">{error}</p>}
  </section>;
}
