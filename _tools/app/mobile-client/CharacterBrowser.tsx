import {HeaderTools} from './HeaderTools';
import {usePublicationCheck} from './usePublicationCheck';
import {useCallback,useEffect,useRef,useState,type MutableRefObject} from 'react';
import {ArrowLeftIcon,ChevronLeftIcon,ChevronRightIcon,FolderIcon,PhotoIcon,UserGroupIcon} from '@heroicons/react/24/outline';
import {Button,IconButton} from './ui';
import {api,errorText} from './transport';
import {loadThumbnail} from './media';
import {Gallery} from './Gallery';
import {RequestGate} from './model';
import type {Asset} from './types';
import {characterChildren,characterPath,validCharacterIndex,type CharacterFilter,type CharacterIndex,type CharacterNode,type CharacterPage} from './characterModel';
import './characters.css';

type Location={node:string|null;filter:CharacterFilter};
type Cached={page:CharacterPage;scroll:number};
const ROOT:Location={node:null,filter:'all'};
const labels:Record<CharacterFilter,string>={all:'전체',unclassified:'미분류',needs_review:'추가 확인'};

function Preview({id,paused,label=''}:{id?:string|null;paused:boolean;label?:string}) {
  const [preview,setPreview]=useState<string>();
  useEffect(()=>{
    setPreview(undefined);if(paused||!id)return;
    const controller=new AbortController();
    void loadThumbnail({id,kind:'image'},controller.signal).then(a=>{if(!controller.signal.aborted)setPreview(a.preview);},()=>{});
    return()=>controller.abort();
  },[id,paused]);
  return preview?<img src={preview} alt={label}/>:<PhotoIcon aria-hidden="true"/>;
}
function Card({node,count,paused,onSelect,previews=[]}:{node:CharacterNode;count:number;paused:boolean;onSelect():void;previews?:string[]}) {
  return <button className="character-card" data-kind={node.kind} onClick={onSelect} aria-label={`${node.name} · ${count}개`}>
    <span className={`character-card-image${node.kind==='group'?' character-mosaic':''}`} data-count={previews.length}>
      {node.kind==='group'&&previews.length?previews.map(id=><span key={id}><Preview id={id} paused={paused}/></span>):node.thumbnailAssetId?<Preview id={node.thumbnailAssetId} paused={paused}/>:node.kind==='folder'?<FolderIcon/>:<PhotoIcon/>}
    </span>
    <span className="character-card-caption"><strong>{node.kind==='group'?<UserGroupIcon/>:node.kind==='folder'?<FolderIcon/>:null}{node.name}</strong><span className="muted numeric">{count}개</span></span>
    {node.excluded&&<small>자동 분류 제외</small>}
  </button>;
}

export function CharacterBrowser({onLocation,initialNode,active,paused,density,refreshKey,onOpen,backRef}:{onLocation?(id:string|null):void;initialNode?:string;active:boolean;paused:boolean;density:number;refreshKey:number;onOpen(items:Asset[],index:number):void;backRef:MutableRefObject<(()=>boolean)|null>}) {
  const [landscape,setLandscape]=useState(()=>window.matchMedia?.('(orientation: landscape) and (min-width: 900px)').matches??false);
  useEffect(()=>{const media=window.matchMedia?.('(orientation: landscape) and (min-width: 900px)');if(!media)return;const change=()=>setLandscape(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  const [index,setIndex]=useState<CharacterIndex>();
  const [where,setWhere]=useState<Location>(ROOT);
  useEffect(()=>{onLocation?.(where.node);},[where.node,onLocation]);
  const [page,setPage]=useState<CharacterPage>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[moreError,setMoreError]=useState('');
  const [more,setMore]=useState(false),[cardsPage,setCardsPage]=useState(0),[columns,setColumns]=useState(3);
  const [restore,setRestore]=useState(0);
  const [retry,setRetry]=useState(0);
  const host=useRef<HTMLDivElement>(null),scroll=useRef(0);
  const indexGate=useRef(new RequestGate()),pageGate=useRef(new RequestGate()),moreGate=useRef(new RequestGate());
  const cache=useRef(new Map<string,Cached>()),morePending=useRef(false);
  const latest=useRef({index,where,page,active,paused});latest.current={index,where,page,active,paused};
  const key=(revision:string,location:Location)=>`${revision}:${location.node}:${location.filter}`;
  const remember=useCallback(()=>{
    const s=latest.current;
    if(s.index?.revision&&s.page&&s.where.node){
      const k=key(s.index.revision,s.where);cache.current.delete(k);cache.current.set(k,{page:s.page,scroll:scroll.current});
      while(cache.current.size>6)cache.current.delete(cache.current.keys().next().value!);
    }
  },[]);
  const navigate=useCallback((next:Location)=>{
    remember();pageGate.current.cancel();moreGate.current.cancel();morePending.current=false;
    setRestore(0);scroll.current=0;
    setPage(undefined);setError('');setMoreError('');setMore(false);setWhere(next);setCardsPage(0);
  },[remember]);
  const appliedInitialNode=useRef<string|undefined>(undefined);
  useEffect(()=>{if(active&&initialNode&&appliedInitialNode.current!==initialNode){appliedInitialNode.current=initialNode;navigate({node:initialNode,filter:'all'});}},[initialNode,active,navigate]);
  usePublicationCheck(active&&!paused,'/v1/library/characters/status',index?.revision,()=>setRetry(n=>n+1));
  useEffect(()=>{
    backRef.current=()=>{
      const s=latest.current;
      if(!s.where.node)return false;
      const node=s.index?.nodes.find(n=>n.id===s.where.node);
      navigate({node:node?.parentId??null,filter:'all'});return true;
    };
    return()=>{backRef.current=null;};
  },[backRef,navigate]);
  useEffect(()=>{
    if(!active)return;
    const request=indexGate.current.begin();setBusy(true);setError('');
    pageGate.current.cancel();moreGate.current.cancel();morePending.current=false;setMore(false);
    void api<CharacterIndex>('/v1/library/characters',request.signal).then(result=>{
      if(!indexGate.current.current(request.id))return;
      if(!validCharacterIndex(result))throw new Error('캐릭터 보기를 지원하는 앱과 서버가 필요합니다.');
      remember();
      if(result.revision!==latest.current.index?.revision){cache.current.clear();}
      setIndex(result);
      if(latest.current.where.node&&!result.nodes.some(n=>n.id===latest.current.where.node)){setPage(undefined);setWhere(ROOT);scroll.current=0;setRestore(0);}
    }).catch(reason=>{if(indexGate.current.current(request.id))setError((reason as {status?:number}).status===404?'서버에 캐릭터 보기 업데이트가 필요합니다.':errorText(reason));})
      .finally(()=>{if(indexGate.current.current(request.id))setBusy(false);});
    return()=>indexGate.current.cancel();
  },[active,refreshKey,retry,remember]);
  useEffect(()=>{
    if(!active||!index?.ready||!index.revision||!where.node)return;
    const request=pageGate.current.begin();setBusy(true);setError('');setMoreError('');
    moreGate.current.cancel();morePending.current=false;setMore(false);
    const cached=cache.current.get(key(index.revision,where));
    const promise=cached?Promise.resolve(cached.page):api<CharacterPage>(characterPath(where.node,where.filter,index.revision,null),request.signal);
    void promise.then(result=>{
      if(!pageGate.current.current(request.id))return;
      setPage(result);setRestore(cached?.scroll??scroll.current);scroll.current=cached?.scroll??scroll.current;
    }).catch(reason=>{if(pageGate.current.current(request.id))setError((reason as {status?:number}).status===409?'캐릭터 보기가 변경되었습니다. 새로고침해 주세요.':errorText(reason));})
      .finally(()=>{if(pageGate.current.current(request.id))setBusy(false);});
    return()=>pageGate.current.cancel();
  },[active,index,where]);
  useEffect(()=>()=>{indexGate.current.cancel();pageGate.current.cancel();moreGate.current.cancel();},[]);
  useEffect(()=>{
    if(!active||!host.current)return;
    const observer=new ResizeObserver(()=>setColumns(Math.max(2,Math.min(6,Math.floor((host.current?.clientWidth??600)/(landscape?180:150))))));
    observer.observe(host.current);return()=>observer.disconnect();
  },[active,landscape]);
  const append=useCallback(async()=>{
    const s=latest.current;
    if(!s.active||s.paused||!s.page?.next_cursor||!s.index?.revision||!s.where.node||morePending.current)return;
    morePending.current=true;setMore(true);setMoreError('');
    const request=moreGate.current.begin();
    try{
      const result=await api<CharacterPage>(characterPath(s.where.node,s.where.filter,s.index.revision,s.page.next_cursor),request.signal);
      if(!moreGate.current.current(request.id))return;
      if(result.revision!==s.index.revision||result.next_cursor===s.page.next_cursor)throw new Error('목록이 변경되었습니다. 새로고침해 주세요.');
      setPage(current=>current?{...result,items:[...current.items,...result.items.filter(a=>!current.items.some(b=>a.id===b.id))]}:current);
    }catch(reason){if(moreGate.current.current(request.id))setMoreError(errorText(reason));}
    finally{if(moreGate.current.current(request.id)){morePending.current=false;setMore(false);}}
  },[]);
  const ready=useCallback((asset:Asset)=>setPage(current=>current?{...current,items:current.items.map(a=>a.id===asset.id?{...a,...asset}:a)}:current),[]);
  const nearEnd=useCallback(()=>{if(!busy&&!moreError)void append();},[busy,moreError,append]);
  const node=index?.nodes.find(n=>n.id===where.node);
  const children=index?characterChildren(index,where.node):[];
  const capacity=columns*2,pages=Math.ceil(children.length/capacity),cardPage=Math.min(cardsPage,Math.max(0,pages-1));
  const scope=index?.scopes.find(s=>s.nodeId===where.node&&s.filter===where.filter);
  const ancestors:CharacterNode[]=[];
  let parent=node?.parentId;
  while(parent&&index&&ancestors.length<3){const found=index.nodes.find(n=>n.id===parent);if(!found)break;ancestors.unshift(found);parent=found.parentId;}
  const filterControls=node?.kind==='series'&&<div className="character-filters">{(Object.keys(labels) as CharacterFilter[]).map(filter=><Button key={filter} variant="ghost" aria-pressed={where.filter===filter} onClick={()=>navigate({node:node.id,filter})}>{labels[filter]}</Button>)}</div>;
  const overview=<>
    {!landscape&&filterControls}
    {error&&<div className="inline-error" role="alert">{error}<Button onClick={()=>{cache.current.clear();setRetry(n=>n+1);}}>새로고침</Button></div>}
    {busy&&<div className="loading-line" role="status" aria-label="캐릭터 보기 불러오는 중"/>}
    {index&&!index.ready&&<div className="empty-state"><h3>캐릭터 보기가 아직 공유되지 않았습니다</h3><p>PC 설정에서 모바일 캐릭터 업데이트를 실행하면 여기에서 감상할 수 있습니다.</p></div>}
    {landscape&&node?.kind==='series'&&node.heroAssetId&&<div className="character-hero"><Preview id={node.heroAssetId} paused={!active||paused} label={`${node.name} 대표 이미지`}/></div>}
    {!!children.length&&landscape&&node&&<h4 className="character-section-title">{node.kind==='group'?'그룹 캐릭터':'캐릭터 · 폴더'}</h4>}
    {!!children.length&&<div className={`character-cards${pages>1?' character-cards-paged':''}`} style={{gridTemplateColumns:`repeat(${columns},minmax(0,${landscape?'180px':'1fr'}))`}}>{children.slice(cardPage*capacity,(cardPage+1)*capacity).map(child=><Card key={`${index?.revision}:${child.id}`} node={child} count={index?.scopes.find(s=>s.nodeId===child.id&&s.filter==='all')?.totalCount??0} paused={!active||paused} previews={landscape&&child.kind==='group'?[...new Set(index?.nodes.filter(n=>n.parentId===child.id&&n.thumbnailAssetId).map(n=>n.thumbnailAssetId!)??[])].slice(0,4):[]} onSelect={()=>navigate({node:child.id,filter:'all'})}/>)}</div>}
    {pages>1&&<div className="character-card-pages"><IconButton label="이전 폴더" icon={ChevronLeftIcon} disabled={!cardPage} onClick={()=>setCardsPage(cardPage-1)}/><span>{cardPage+1} / {pages}</span><IconButton label="다음 폴더" icon={ChevronRightIcon} disabled={cardPage+1>=pages} onClick={()=>setCardsPage(cardPage+1)}/></div>}
    {node?.description&&<p className="character-description">{node.description}</p>}
    {landscape&&filterControls}
    {scope&&scope.sourceCount>scope.totalCount&&<p className="character-description">서버에 보관된 {scope.totalCount}개를 표시합니다. 아직 공유되지 않은 자산 {scope.sourceCount-scope.totalCount}개가 있습니다.</p>}
    {index?.ready&&!busy&&!error&&(!where.node&&!children.length||where.node&&page?.items.length===0)&&<div className="empty-state"><h3>{where.node?'이 보기에 자산이 없습니다':'등록된 시리즈가 없습니다'}</h3></div>}
  </>;
  return <section className={`character-browser${landscape?' character-browser-landscape':''}`} style={{display:active?undefined:'none'}} aria-label="시리즈·캐릭터" ref={host}>
    <HeaderTools active={active} target="context-location" landscapeOnly><div className="character-location">{where.node&&<IconButton label="상위 보기로" icon={ArrowLeftIcon} onClick={()=>backRef.current?.()}/>}
      {landscape&&node&&<nav className="character-breadcrumb" aria-label="캐릭터 위치"><Button variant="ghost" onClick={()=>navigate(ROOT)}>시리즈</Button>{ancestors.map(ancestor=><span key={ancestor.id}><ChevronRightIcon/><Button variant="ghost" onClick={()=>navigate({node:ancestor.id,filter:'all'})}>{ancestor.name}</Button></span>)}<ChevronRightIcon/></nav>}
      <h3>{node?.name??'시리즈'}</h3>{scope&&<span className="numeric muted">{scope.totalCount}개</span>}</div></HeaderTools>
    {!landscape&&overview}
    {(landscape||!!page?.items.length)&&<Gallery items={page?.items??[]} intro={landscape?overview:undefined} density={density} identity={`${index?.revision}:${where.node}:${where.filter}`} restoreScroll={restore} onScroll={top=>{scroll.current=top;}} onOpen={i=>{if(page)onOpen(page.items,i);}} onReady={ready} onNearEnd={nearEnd} paused={!active||paused}/>}
    {more&&<div className="loading-line" role="status" aria-label="다음 캐릭터 자산 불러오는 중"/>}
    {moreError&&<div className="inline-error" role="alert">{moreError}<Button onClick={()=>void append()}>다시 시도</Button><Button onClick={()=>{cache.current.clear();setRetry(n=>n+1);}}>새로고침</Button></div>}
  </section>;
}
