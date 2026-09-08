import {useState} from 'react';
import {publishMobileCatalog, type MobileCatalogPublishResult} from '../library/mobileCatalog';
import {commandErrorMessage} from '../library/errorMessage';
import {Button} from '../shared/ui/Button';

export function MobileCatalogPublishSettings() {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [result,setResult]=useState<MobileCatalogPublishResult|null>(null);
  async function publish(){
    if(busy)return;
    setBusy(true);setError('');
    try{setResult(await publishMobileCatalog());}
    catch(reason){setError(commandErrorMessage(reason,'모바일 카탈로그를 게시하지 못했습니다. 클라우드 연결과 카탈로그 준비 상태를 확인해 주세요.'));}
    finally{setBusy(false);}
  }
  return <section className="settings-section" aria-label="모바일 카탈로그">
    <h3>모바일 카탈로그</h3>
    <p className="settings-description">현재 카탈로그와 북마크를 클라우드에 게시하면 PC가 꺼져 있어도 모바일에서 볼 수 있습니다.</p>
    <Button disabled={busy} onClick={()=>{void publish();}}>{busy?'카탈로그 게시 중…':'모바일에 카탈로그 게시'}</Button>
    {result&&<p role="status">{result.works.toLocaleString()}개 · {new Date(result.publishedAt).toLocaleString()} 게시</p>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
