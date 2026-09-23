import {useEffect,useState} from 'react';
import {PhotoIcon,PlayIcon} from '@heroicons/react/24/outline';
import {loadThumbnail} from './media';
import type {Asset} from './types';
export function Cover({asset, paused}: {asset:Asset; paused:boolean}) {
  const source = JSON.stringify([asset.id,asset.kind,asset.preview,asset.thumbnail_available,asset.pending]);
  const [loaded,setLoaded] = useState<{source:string;preview?:string}|null>(null);
  const preview = asset.preview ?? (loaded?.source === source ? loaded.preview : undefined);
  useEffect(() => {
    if (paused || preview) return;
    const controller = new AbortController();
    void loadThumbnail(asset,controller.signal).then(ready => {
      if (!controller.signal.aborted) setLoaded({source,preview:ready.preview});
    },() => {});
    return () => controller.abort();
  },[source,preview,paused]);
  return <span className="home-cover">{preview ? <img src={preview} alt="" loading="lazy" draggable={false}/> : <PhotoIcon className="missing-media"/>}{asset.kind === 'video' && <span className="video-mark"><PlayIcon/></span>}</span>;
}
export function CoverGroup({items,paused}: {items:Asset[];paused:boolean}) {
  return <span className={`home-cover-group ${items.length < 2 ? 'single' : ''}`}>{items.slice(0,3).map(asset => <Cover key={asset.id} asset={asset} paused={paused}/>)}{!items.length && <span className="home-cover"><PhotoIcon className="missing-media"/></span>}</span>;
}
