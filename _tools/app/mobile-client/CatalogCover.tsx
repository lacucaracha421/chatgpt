import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {arrive,holdImage} from './motion';
import {catalogImageTicket} from './catalogMedia';
import type {CatalogItem} from './catalogModel';

/** A catalog cover, loaded once it scrolls near the screen. Shared by the list, the detail and the duplicate review. */
export function CatalogCover({item,revision,active,onUrl}:{item:Pick<CatalogItem,'provider'|'providerWorkId'|'thumbnailUrl'>;revision:string;active:boolean;onUrl?(url:string|null):void}){
  const [image,setImage]=useState<{source:string;url:string}|null>(null),[failed,setFailed]=useState<string|null>(null),[visible,setVisible]=useState(false);
  const host=useRef<HTMLSpanElement>(null),picture=useRef<HTMLImageElement>(null),loaded=useRef<string|null>(null);
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
  // The cover box is already sized, so a cover that comes late fades in instead of popping.
  useLayoutEffect(()=>{if(shown)holdImage(picture.current);},[shown]);
  return <span className="catalog-cover-image" ref={host}>{image?.source===source&&failed!==source?<img ref={picture} src={image.url} alt="" onLoad={event=>{const element=event.currentTarget;void (typeof element.decode==='function'?element.decode():Promise.resolve()).catch(()=>{}).then(()=>arrive(element));}} onError={event=>{arrive(event.currentTarget);loaded.current=null;setFailed(source);}}/>:null}</span>;
}
