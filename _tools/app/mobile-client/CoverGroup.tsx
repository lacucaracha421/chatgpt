import {useEffect,useRef,useState} from 'react';
import {PhotoIcon,PlayIcon} from '@heroicons/react/24/outline';
import {loadThumbnail} from './media';
import type {Asset} from './types';
/** A cover whose thumbnail did not load tries again after these delays, then waits for `paused` or the asset to change. */
const COVER_RETRY_MS=[1000,3000,10_000];
export function Cover({asset, paused}: {asset:Asset; paused:boolean}) {
  const source = JSON.stringify([asset.id,asset.kind,asset.preview,asset.thumbnail_available,asset.pending]);
  const [loaded,setLoaded] = useState<{source:string;preview?:string}|null>(null);
  const [attempt,setAttempt] = useState(0);
  const retries = useRef({source,count:0});
  const preview = asset.preview ?? (loaded?.source === source ? loaded.preview : undefined);
  useEffect(() => {
    // Pausing (a hidden tab or an off-screen card) ends the retries; resuming starts a fresh budget.
    if (paused) { retries.current = {source,count:0}; return; }
    if (preview) return;
    const controller = new AbortController();
    let timer = 0;
    void loadThumbnail(asset,controller.signal).then(ready => {
      if (controller.signal.aborted) return;
      setLoaded({source,preview:ready.preview});
      // A failed thumbnail resolves without a preview; pending and thumbnail-less assets never have one.
      if (ready.preview || asset.pending || asset.thumbnail_available === false) return;
      if (retries.current.source !== source) retries.current = {source,count:0};
      const delay = COVER_RETRY_MS[retries.current.count];
      if (delay === undefined) return;
      retries.current.count++;
      timer = window.setTimeout(() => setAttempt(value => value + 1),delay);
    },() => {});
    return () => { controller.abort(); window.clearTimeout(timer); };
  },[source,preview,paused,attempt]);
  return <span className="home-cover">{preview ? <img src={preview} alt="" loading="lazy" draggable={false}/> : <PhotoIcon className="missing-media"/>}{asset.kind === 'video' && <span className="video-mark"><PlayIcon/></span>}</span>;
}
export function CoverGroup({items,paused}: {items:Asset[];paused:boolean}) {
  return <span className={`home-cover-group ${items.length < 2 ? 'single' : ''}`}>{items.slice(0,3).map(asset => <Cover key={asset.id} asset={asset} paused={paused}/>)}{!items.length && <span className="home-cover"><PhotoIcon className="missing-media"/></span>}</span>;
}
