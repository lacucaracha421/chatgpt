import {useEffect,useRef,useState} from 'react';
import {afterDecode,arrive,type CardArrival} from './motion';
import {catalogImageTicket} from './catalogMedia';
import {catalogCoverDecoded} from './catalogPerf';
import {useTabletCatalogMasked} from './catalogMask';
import type {CatalogItem} from './catalogModel';
import {observeCatalogCover} from './catalogCoverObservers';
/** A nearby cover stays subscribed through quick viewport exits; a far cover is canceled. */
export function CatalogCover({item,revision,active,onUrl,arrival}:{item:Pick<CatalogItem,'provider'|'providerWorkId'|'thumbnailUrl'>;revision:string;active:boolean;onUrl?(url:string|null):void;arrival?:CardArrival}){
  const privacy = useTabletCatalogMasked();
  const [image,setImage]=useState<{source:string;url:string}|null>(null),[failed,setFailed]=useState<string|null>(null),[near,setNear]=useState(false),[decoded,setDecoded]=useState<string|null>(null);
  const host=useRef<HTMLSpanElement>(null),picture=useRef<HTMLImageElement>(null),loaded=useRef<string|null>(null),visible=useRef(false);
  const source=JSON.stringify([item.provider,item.providerWorkId,item.thumbnailUrl,revision]);
  useEffect(()=>{
    const element=host.current;if(!element)return;
    return observeCatalogCover(element,value=>{visible.current=value;},setNear);
  },[]);
  useEffect(()=>{
    if(privacy||!active||!near||!item.thumbnailUrl||loaded.current===source)return;setFailed(null);
    const controller=new AbortController();
    void catalogImageTicket({workId:item.providerWorkId,revision,kind:'cover',index:0,url:item.thumbnailUrl},controller.signal,()=>visible.current).then(ticket=>{
      if(controller.signal.aborted)return;
      if(!ticket.url.startsWith('https://app.lakomics.local/media-cache/')&&!(import.meta.env.DEV&&ticket.url.startsWith('data:image/')))throw new Error('Invalid catalog cover');
      loaded.current=source;setImage({source,url:ticket.url});
    }).catch(()=>{if(!controller.signal.aborted)setFailed(source);});
    // A viewport exit does not change `near`: even an in-flight preload gets two rows to finish.
    return()=>controller.abort();
  },[source,active,near,privacy]);
  const shown=!privacy&&image?.source===source&&failed!==source?image.url:null;
  useEffect(()=>{onUrl?.(shown);},[shown,onUrl]);
  useEffect(()=>{if(privacy||!item.thumbnailUrl||failed===source)arrival?.ready();},[privacy,item.thumbnailUrl,failed,source,arrival]);
  const settle=(element:HTMLImageElement)=>{
    if(picture.current!==element||!element.isConnected)return;
    arrival?.ready();arrive(element);
    setDecoded(source);
    if(host.current)catalogCoverDecoded(host.current);
  };
  return <span className="catalog-cover-image" ref={host} data-catalog-cover={item.thumbnailUrl?item.providerWorkId:undefined} data-catalog-decoded={shown&&decoded===source?'true':undefined}>{privacy?<span className="privacy-mask" aria-label="비공개 모드"/>:shown?<img key={source} ref={picture} src={shown} alt="" onLoad={event=>{const element=event.currentTarget;afterDecode(element,()=>settle(element));}} onError={()=>{arrival?.ready();loaded.current=null;setFailed(source);}}/>:null}</span>;
}
