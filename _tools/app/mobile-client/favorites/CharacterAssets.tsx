import {useCallback,useEffect,useRef,useState,type CSSProperties} from 'react';
import {PhotoIcon} from '@heroicons/react/24/outline';
import {StableImage} from '../../src/shared/ui/StableImage';
import {useTabletAssetMask} from '../assetMask';
import {loadThumbnail,prepareAssets} from '../media';
import {api,errorText} from '../transport';
import {characterPath,type CharacterIndex,type CharacterNode,type CharacterPage} from '../characterModel';
import type {Asset} from '../types';
import type {FavoriteEntry} from '../../src/library/types';
import {isManualFavorite,representativeAsset} from './model';

export function useFirstCharacterAsset(node:string,revision:string,enabled:boolean) {
  const [first,setFirst]=useState<Asset>();
  useEffect(()=>{
    if(!enabled||!revision)return;
    const controller=new AbortController();
    void api<CharacterPage>(characterPath(node,'all',revision,null),controller.signal).then(page=>{
      if(!controller.signal.aborted)setFirst(page.items[0]);
    },()=>{});
    return()=>controller.abort();
  },[node,revision,enabled]);
  return first;
}

export function CharacterImage({id,y=50,rating,style,onError,onPrepared}:{id?:string|null;y?:number;rating?:Asset['contentRating'];style?:CSSProperties;onError?():void;onPrepared?():void}) {
  const masked=useTabletAssetMask({contentRating:rating});
  const [preview,setPreview]=useState<string>();
  const failure=useRef(onError);failure.current=onError;
  const prepared=useRef(onPrepared);prepared.current=onPrepared;
  useEffect(()=>{
    if(!id||masked){prepared.current?.();return;}
    const controller=new AbortController();
    void loadThumbnail({id,kind:'image',contentRating:rating},controller.signal).then(asset=>{
      if(!controller.signal.aborted){if(asset.preview)setPreview(asset.preview);else prepared.current?.();}
    },()=>{if(!controller.signal.aborted){failure.current?.();prepared.current?.();}});
    return()=>controller.abort();
  },[id,masked,rating]);
  useEffect(()=>{if(preview)prepared.current?.();},[preview]);
  return <span className="favorite-image" style={style}>{masked?<span className="privacy-mask" aria-label="이미지 숨김"/>:preview&&id?<StableImage src={preview} alt="" style={{objectPosition:`50% ${y}%`}} respectReducedMotion onError={()=>failure.current?.()} onPreloadError={()=>failure.current?.()}/>:<PhotoIcon aria-hidden="true"/>}</span>;
}

/** Same fallback sequence as the PC portrait, including a removed representative asset. */
export function CharacterPortrait({entry,node,index,firstAsset,onPrepared}:{entry?:FavoriteEntry;node:CharacterNode;index:CharacterIndex;firstAsset?:Asset;onPrepared?(id:string|null):void}) {
  const manual=isManualFavorite(entry?.characterId??node.sourceId);
  const [failed,setFailed]=useState<string[]>([]);
  const available=(id?:string|null)=>id&&!failed.includes(id)?id:null;
  const cover=available(entry?.coverAssetId),thumbnail=available(node.thumbnailAssetId);
  const fallback=useFirstCharacterAsset(node.id,index.revision??'',!manual&&!cover&&!thumbnail&&!firstAsset);
  const first=firstAsset??fallback;
  const id=representativeAsset({coverAssetId:cover},{id:entry?.characterId??node.sourceId,thumbnailAssetId:thumbnail},available(first?.id));
  const requestedId=representativeAsset(entry,{id:entry?.characterId??node.sourceId,thumbnailAssetId:node.thumbnailAssetId},firstAsset?.id);
  const masked=useTabletAssetMask({contentRating:index.contentRatings?.[id??'']});
  const prepared=useRef(onPrepared);prepared.current=onPrepared;
  useEffect(()=>{if(manual&&(!id||masked))prepared.current?.(requestedId);},[manual,id,masked,requestedId]);
  if(manual&&(!id||masked))return <span className="favorite-name-card"><strong>{entry?.name}</strong>{entry?.seriesName&&<small>{entry.seriesName}</small>}</span>;
  return <CharacterImage id={id} y={entry?.coverY} onPrepared={()=>onPrepared?.(requestedId)} rating={index.contentRatings?.[id??'']??(id===first?.id?first?.contentRating:undefined)} onError={()=>{if(id)setFailed(before=>before.includes(id)?before:[...before,id]);}}/>;
}

export function useCharacterAssets(node:string,revision:string,enabled:boolean) {
  const [page,setPage]=useState<CharacterPage>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const latest=useRef(page);latest.current=page;
  const request=useRef<AbortController|null>(null),generation=useRef(0);
  const read=useCallback((more=false)=>{
    if(!enabled||more&&(!latest.current?.has_more||request.current))return;
    request.current?.abort();
    const controller=new AbortController(),at=++generation.current;request.current=controller;
    setBusy(true);setError('');
    const cursor=more?latest.current?.next_cursor??null:null;
    void api<CharacterPage>(characterPath(node,'all',revision,cursor),controller.signal).then(async reply=>{
      // First-page replacements are prepared before the painted gallery changes.
      const ready=await prepareAssets(reply.items.slice(0,12),controller.signal);
      const prepared=new Map(ready.map(asset=>[asset.id,asset]));
      if(controller.signal.aborted||at!==generation.current)return;
      setPage(before=>({...reply,items:more?[...(before?.items??[]),...reply.items.filter(asset=>!before?.items.some(old=>old.id===asset.id))]:reply.items.map(asset=>prepared.get(asset.id)??asset)}));
    }).catch(reason=>{if(!controller.signal.aborted&&at===generation.current)setError(errorText(reason));})
      .finally(()=>{if(at===generation.current){request.current=null;setBusy(false);}});
  },[node,revision,enabled]);
  useEffect(()=>{if(enabled)read();return()=>{request.current?.abort();request.current=null;generation.current++;};},[read,enabled]);
  const ready=useCallback((asset:Asset)=>setPage(before=>before?{...before,items:before.items.map(item=>item.id===asset.id?asset:item)}:before),[]);
  return {page,busy,error,reload:()=>read(),more:()=>read(true),ready};
}
