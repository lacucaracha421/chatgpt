import {useEffect,useState} from 'react';
import {useTabletAssetMask} from './assetMask';
import {Skeleton} from './ui';
import {decodeImage,mediaTicket} from './media';
import {DESCRIPTION_PREVIEW_COUNT,type DescriptionAnswer} from './descriptionSearch';
import type {Asset} from './types';

export type StripMedia=Map<string,{url:string;promise:Promise<string>}>;
/** A slot keeps its picture until the next one has decoded; masked ratings never request media. */
function StripCell({asset,cache,signal}:{asset:Asset;cache:StripMedia;signal:AbortSignal}) {
  const masked=useTabletAssetMask(asset);
  const [url,setUrl]=useState(()=>cache.get(asset.id)?.url??'');
  useEffect(()=>{
    if(masked||asset.thumbnail_available===false)return;
    let active=true;
    let cached=cache.get(asset.id);
    if(!cached){
      const fresh:{url:string;promise:Promise<string>}={url:'',promise:Promise.resolve('')};
      fresh.promise=mediaTicket(asset,'thumbnail',signal).then(async ticket=>{if(signal.aborted)return '';await decodeImage(ticket.url,signal);fresh.url=ticket.url;return ticket.url;}).catch(()=>'');
      cache.set(asset.id,fresh);cached=fresh;
    }
    void cached.promise.then(value=>{if(active&&value&&!signal.aborted)setUrl(value);});
    return()=>{active=false;};
  },[asset.id,asset.thumbnail_available,masked,cache,signal]);
  return masked?<span className="privacy-mask" aria-hidden="true"/>:url?<img src={url} alt="" draggable={false}/>:null;
}

/**
 * The top matches as small squares under the "이미지 내용" row. The previous answer stays painted while
 * the next one loads; placeholders show only before the first answer. A quiet sentence replaces the
 * squares when the captions are not there yet, nothing matched, or the read failed.
 */
export function DescriptionStrip({answer,failed,cache,signal,privacy}:{answer:DescriptionAnswer|null;failed:boolean;cache:StripMedia;signal:AbortSignal;privacy:boolean}) {
  const status=failed?'내용 검색을 할 수 없습니다.':answer&&!answer.ready?'아직 준비 중':answer&&!answer.items.length?'검색 결과 없음':null;
  const items=answer?.items.slice(0,DESCRIPTION_PREVIEW_COUNT);
  const cells=privacy?null:<span className="tablet-find__strip" aria-hidden="true">{items&&!status
    ?items.map((asset,index)=><span key={index} className="tablet-find__thumb"><StripCell asset={asset} cache={cache} signal={signal}/></span>)
    :!answer&&!status?Array.from({length:DESCRIPTION_PREVIEW_COUNT},(_,index)=><Skeleton key={index} className="tablet-find__thumb" label={null}/>):null}</span>;
  return <span className="tablet-find__strip-area">{status?<span className="tablet-find__strip-status">{status}</span>:cells}</span>;
}
