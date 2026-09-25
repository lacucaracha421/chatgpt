import {useEffect,useRef,useState} from 'react';
import {catalogImageTicket} from './catalogMedia';
import type {CatalogItem} from './catalogModel';

/** A catalog cover, loaded once it scrolls near the screen. Shared by the list, the detail and the duplicate review. */
export function CatalogCover({item,revision,active,onUrl}:{item:Pick<CatalogItem,'provider'|'providerWorkId'|'thumbnailUrl'>;revision:string;active:boolean;onUrl?(url:string|null):void}){
  const [image,setImage]=useState<{source:string;url:string}|null>(null),[failed,setFailed]=useState<string|null>(null),[visible,setVisible]=useState(false);
  const host=useRef<HTMLSpanElement>(null),loaded=useRef<string|null>(null);
  const source=JSON.stringify([item.provider,item.providerWorkId,item.thumbnailUrl,revision]);
  useEffect(()=>{if(!host.current)return;if(!window.IntersectionObserver){setVisible(true);return;}const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)),{rootMargin:'120px'});observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    if(!active||!visible||!item.thumbnailUrl||loaded.current===source)return;setFailed(null);
    const controller=new AbortController();
    void catalogImageTicket({workId:item.providerWorkId,revision,kind:'cover',index:0,url:item.thumbnailUrl},controller.signal).then(ticket=>{
      if(controller.signal.aborted)return;
      if(!ticket.url.startsWith('https://app.lakomics.local/media-cache/')&&!(import.meta.env.DEV&&ticket.url.startsWith('data:image/')))throw new Error('Invalid catalog cover');
      loaded.current=source;setImage({source,url:ticket.url});
    }).catch(()=>{if(!controller.signal.aborted)setFailed(source);});
    return()=>controller.abort();
  },[source,active,visible]);
  const shown=image?.source===source&&failed!==source?image.url:null;
  useEffect(()=>{onUrl?.(shown);},[shown,onUrl]);
  return <span className="catalog-cover-image" ref={host}>{image?.source===source&&failed!==source?<img src={image.url} alt="" onError={()=>{loaded.current=null;setFailed(source);}}/>:null}</span>;
}
