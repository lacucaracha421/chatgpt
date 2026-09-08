import {useEffect,useRef,useState} from 'react';
import {ArrowLeftIcon,ArrowPathIcon,ChevronLeftIcon,ChevronRightIcon,MagnifyingGlassMinusIcon} from '@heroicons/react/24/outline';
import {Dialog,DialogDescription,IconButton,Button} from './ui';
import {catalogImageTicket} from './catalogMedia';
import {fitTransform} from './model';
import type {CatalogReaderManifest,CatalogReaderPage} from './catalogModel';
import './CatalogReader.css';

function positionKey(workId:string){return `lakomics.catalog.reading.kHentai:${workId}`;}
function savedPage(workId:string,count:number){
  const value=Number.parseInt(localStorage.getItem(positionKey(workId))??'0',10);
  return Number.isFinite(value)?Math.max(0,Math.min(count-1,value)):0;
}

type Transform={scale:number;x:number;y:number};
function ReaderPage({workId,manifestRevision,page,transform,onRefresh,onFailure}:{workId:string;manifestRevision:string;page:CatalogReaderPage;transform?:Transform;onRefresh():void;onFailure():void}){
  const [src,setSrc]=useState(''),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    setSrc('');setFailed(false);const controller=new AbortController();
    void catalogImageTicket({workId,revision:manifestRevision,kind:'page',index:page.index,url:page.url},controller.signal).then(ticket=>{
      if(controller.signal.aborted)return;
      if(!ticket.url.startsWith('https://app.lakomics.local/media-cache/')&&!(import.meta.env.DEV&&ticket.url.startsWith('data:image/')))throw new Error('Invalid catalog page');
      setSrc(ticket.url);
    }).catch(()=>{if(!controller.signal.aborted){setFailed(true);onFailure();}});
    return()=>controller.abort();
  },[workId,manifestRevision,page.index,page.url,retry]);
  const style=transform?{transform:`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`}:undefined;
  return <div className="catalog-reader-page" data-page={page.index}>
    {src&&!failed?<img src={src} alt={`${page.index+1}페이지`} draggable={false} style={style}/>:failed?<div className="catalog-reader-page-error"><span>페이지를 불러오지 못했습니다.</span><div><Button size="sm" variant="ghost" onClick={()=>setRetry(v=>v+1)}>다시 시도</Button><Button size="sm" variant="ghost" onClick={onRefresh}>주소 갱신</Button></div></div>:<div className="catalog-reader-page-loading">페이지 불러오는 중…</div>}
  </div>;
}

export function CatalogReader({manifest,title,onClose,onRefresh,refreshing}:{manifest:CatalogReaderManifest;title:string;onClose():void;onRefresh():void;refreshing:boolean}){
  const initial=savedPage(manifest.providerWorkId,manifest.pages.length);
  const [current,setCurrent]=useState(initial),[chrome,setChrome]=useState(false),[transform,setTransform]=useState<Transform>({scale:1,x:0,y:0});
  const stage=useRef<HTMLDivElement>(null),autoRefresh=useRef(false);
  const gesture=useRef({points:new Map<number,{x:number;y:number}>(),startX:0,startY:0,distance:0,scale:1,lastX:0,lastY:0,moved:false,pinched:false});
  const refreshOnce=()=>{if(!autoRefresh.current){autoRefresh.current=true;onRefresh();}};
  const change=(next:number)=>{if(next>=0&&next<manifest.pages.length){setCurrent(next);setTransform({scale:1,x:0,y:0});}};
  const distance=()=>{const [a,b]=[...gesture.current.points.values()];return a&&b?Math.hypot(a.x-b.x,a.y-b.y):0;};
  const clamp=(scale:number,x:number,y:number)=>{
    const rect=stage.current?.getBoundingClientRect();if(!rect)return {scale,x,y};
    const page=manifest.pages[current],aspect=page?.width&&page?.height?page.width/page.height:2/3;
    return fitTransform(scale,x,y,rect.width,rect.height,aspect);
  };
  useEffect(()=>{if(current>=manifest.pages.length)setCurrent(Math.max(0,manifest.pages.length-1));},[current,manifest.pages.length]);
  useEffect(()=>{setTransform({scale:1,x:0,y:0});gesture.current.points.clear();},[current,manifest.providerWorkId]);
  useEffect(()=>{localStorage.setItem(positionKey(manifest.providerWorkId),String(current));},[manifest.providerWorkId,current]);
  useEffect(()=>{if(!chrome)return;const timer=setTimeout(()=>setChrome(false),3500);return()=>clearTimeout(timer);},[chrome]);
  const nearby=manifest.pages.filter(page=>Math.abs(page.index-current)<=2);
  return <Dialog open title="만화 읽기" variant="fullscreen" onClose={onClose} onKeyDown={event=>{
    if(transform.scale>1)return;if(event.key==='ArrowLeft'){event.preventDefault();change(current-1);}if(event.key==='ArrowRight'){event.preventDefault();change(current+1);}
  }}>
    <DialogDescription className="sr-only">한 화면에 한 페이지씩 표시합니다. 두 손가락으로 확대하고 확대하지 않은 상태에서 좌우로 넘깁니다. 화면을 짧게 탭하면 정보 표시가 나타납니다.</DialogDescription>
    <div className={`catalog-reader ${chrome?'chrome-visible':''}`}>
      <div ref={stage} className="catalog-reader-stage" aria-label="만화 페이지" onPointerDown={event=>{
        if(event.button>0)return;event.currentTarget.setPointerCapture?.(event.pointerId);const g=gesture.current;g.points.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if(g.points.size===1)Object.assign(g,{startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,moved:false,pinched:false});
        if(g.points.size===2){g.distance=distance();g.scale=transform.scale;g.pinched=true;}
      }} onPointerMove={event=>{
        const g=gesture.current;if(!g.points.has(event.pointerId))return;g.points.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if(Math.hypot(event.clientX-g.startX,event.clientY-g.startY)>8)g.moved=true;
        if(g.points.size===2&&g.distance>0){const scale=Math.min(5,Math.max(1,g.scale*distance()/g.distance));setTransform(t=>clamp(scale,t.x,t.y));}
        else if(transform.scale>1){const dx=event.clientX-g.lastX,dy=event.clientY-g.lastY;setTransform(t=>clamp(t.scale,t.x+dx,t.y+dy));}
        g.lastX=event.clientX;g.lastY=event.clientY;
      }} onPointerUp={event=>{
        const g=gesture.current;if(!g.points.has(event.pointerId))return;g.points.delete(event.pointerId);
        if(g.points.size===1){const remaining=[...g.points.values()][0];g.lastX=remaining.x;g.lastY=remaining.y;}
        const dx=event.clientX-g.startX,dy=event.clientY-g.startY;
        if(g.points.size===0&&!g.pinched&&transform.scale===1&&Math.abs(dx)>56&&Math.abs(dx)>Math.abs(dy)*1.2)change(current+(dx<0?1:-1));
        else if(g.points.size===0&&!g.moved&&!g.pinched)setChrome(v=>!v);
      }} onPointerCancel={()=>gesture.current.points.clear()}>
        {nearby.map(page=><div key={page.index} className={`catalog-reader-slot ${page.index===current?'is-current':'is-prefetch'}`}><ReaderPage workId={manifest.providerWorkId} manifestRevision={manifest.publicationRevision} page={page} transform={page.index===current?transform:undefined} onRefresh={onRefresh} onFailure={refreshOnce}/></div>)}
      </div>
      <header className="catalog-reader-bar"><IconButton label="읽기 닫기" icon={ArrowLeftIcon} onClick={onClose}/><div><strong>{title}</strong><span>{current+1} / {manifest.pages.length}</span></div><IconButton label="페이지 주소 갱신" icon={ArrowPathIcon} disabled={refreshing} onClick={onRefresh}/></header>
      {transform.scale>1&&<div className="catalog-reader-zoom-reset"><IconButton label="화면에 맞추기" icon={MagnifyingGlassMinusIcon} onClick={()=>setTransform({scale:1,x:0,y:0})}/></div>}
      <footer className="catalog-reader-footer"><IconButton label="이전 페이지" icon={ChevronLeftIcon} disabled={current===0} onClick={()=>change(current-1)}/><span>{current+1} / {manifest.pages.length}</span><IconButton label="다음 페이지" icon={ChevronRightIcon} disabled={current===manifest.pages.length-1} onClick={()=>change(current+1)}/></footer>
    </div>
  </Dialog>;
}
