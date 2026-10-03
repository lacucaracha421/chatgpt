import {useEffect,useRef,useState} from 'react';
import {afterDecode,arrive,type CardArrival} from './motion';
import {catalogImageTicket} from './catalogMedia';
import {catalogCoverDecoded} from './catalogPerf';
import {usePrivacyMode} from './privacyMode';
import type {CatalogItem} from './catalogModel';

/** Two real card rows, including the grid gap, rather than a fixed device-specific distance. */
export function catalogCoverMargin(host:HTMLElement){
  const card=host.closest('.catalog-card')??host.parentElement??host;
  const grid=card.parentElement;
  const gap=grid?parseFloat(getComputedStyle(grid).rowGap)||0:0;
  return Math.ceil(2*(card.getBoundingClientRect().height+gap));
}
/** A nearby cover stays subscribed through quick viewport exits; a far cover is canceled. */
export function CatalogCover({item,revision,active,onUrl,arrival}:{item:Pick<CatalogItem,'provider'|'providerWorkId'|'thumbnailUrl'>;revision:string;active:boolean;onUrl?(url:string|null):void;arrival?:CardArrival}){
  const [privacy] = usePrivacyMode();
  const [image,setImage]=useState<{source:string;url:string}|null>(null),[failed,setFailed]=useState<string|null>(null),[near,setNear]=useState(false),[decoded,setDecoded]=useState<string|null>(null);
  const host=useRef<HTMLSpanElement>(null),picture=useRef<HTMLImageElement>(null),loaded=useRef<string|null>(null),visible=useRef(false);
  const source=JSON.stringify([item.provider,item.providerWorkId,item.thumbnailUrl,revision]);
  useEffect(()=>{
    const element=host.current;if(!element)return;
    const root=element.closest('.catalog-scroll, .catalog-detail, .catalog-edition-row');
    if(!window.IntersectionObserver){
      const measure=()=>{
        const box=element.getBoundingClientRect(),bounds=root?.getBoundingClientRect()??{top:0,bottom:window.innerHeight,left:0,right:window.innerWidth};
        const margin=catalogCoverMargin(element),horizontal=box.right>bounds.left&&box.left<bounds.right;
        visible.current=box.height>0&&horizontal&&box.bottom>bounds.top&&box.top<bounds.bottom;
        setNear(box.height>0&&horizontal&&box.bottom>bounds.top-margin&&box.top<bounds.bottom+margin);
      };
      measure();window.addEventListener('scroll',measure,true);window.addEventListener('resize',measure);
      return()=>{window.removeEventListener('scroll',measure,true);window.removeEventListener('resize',measure);};
    }
    const onscreen=new IntersectionObserver(entries=>{visible.current=entries.some(e=>e.isIntersecting);},{root});
    onscreen.observe(element);
    let nearby:IntersectionObserver|null=null;
    const resize=()=>{
      nearby?.disconnect();
      const margin=catalogCoverMargin(element);
      nearby=new IntersectionObserver(entries=>setNear(entries.some(e=>e.isIntersecting)),{root,rootMargin:`${margin}px 0px`});
      nearby.observe(element);
    };
    resize();
    const sizing=window.ResizeObserver?new ResizeObserver(resize):null;
    sizing?.observe(element.closest('.catalog-card')??element);
    window.addEventListener('resize',resize);
    return()=>{onscreen.disconnect();nearby?.disconnect();sizing?.disconnect();window.removeEventListener('resize',resize);};
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
