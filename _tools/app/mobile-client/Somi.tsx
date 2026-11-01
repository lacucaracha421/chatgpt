import {useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type MutableRefObject} from 'react';
import {Squares2X2Icon,ArrowPathIcon,ArrowRightOnRectangleIcon} from '@heroicons/react/24/outline';
import {BookmarkToggle} from '../src/shared/ui/BookmarkToggle';
import {ViewOptionsSection} from '../src/shared/ui/ViewOptionsSection';
import {useDelayedBusy} from '../src/shared/useDelayedBusy';
import {waitForViewportImages,revealTogether} from '../src/shared/motion/viewportImages';
import {native} from './transport';
import {Button,EmptyState,SegmentedControl} from './ui';
import {TopBar,TopBarSearch} from './TopBar';
import {useSectionShade} from './SectionShade';
import {BottomSheet} from './BottomSheet';
import {CatalogCover,prepareCatalogCovers} from './CatalogCover';
import {CatalogCard} from './CatalogCard';
import {CatalogReader} from './CatalogReader';
import {useTabletCatalogMasked} from './catalogMask';
import {useLevelMotion} from './motion';
import {CATALOG_SOURCES,type CatalogSource} from './catalogSources';
import type {CatalogReaderManifest} from './catalogModel';
import type {SomiPost,SomiSearchPage,SomiStatus,SomiSort} from '../src/library/types';
import './Catalog.css';
import './Somi.css';

const SORTS:readonly {value:SomiSort;label:string}[]=[{value:'new',label:'최신순'},{value:'old',label:'오래된순'},{value:'votes',label:'추천순'},{value:'views',label:'조회순'},{value:'comments',label:'댓글순'}];
const PERIODS=[{value:'all',label:'전체'},{value:'7',label:'1주'},{value:'30',label:'1개월'},{value:'90',label:'3개월'},{value:'365',label:'1년'}];
type Options={query:string;sort:SomiSort;days:number|null;bookmarked:boolean};
type View={result:SomiSearchPage;options:Options;page:number;generation:number;fillIds:string[]};
type OpenResponse={title:string;writer:string;initialPage:number;manifest:CatalogReaderManifest};
type Opened=OpenResponse&{id:string;post:SomiPost};
const FILL_BATCH=6;
const sameOptions=(a:Options,b:Options)=>a.query===b.query&&a.sort===b.sort&&a.days===b.days&&a.bookmarked===b.bookmarked;
const errorText=(error:unknown)=>String(error).includes('SOMI_POST_GONE')?'사라졌거나 열 수 없는 게시글입니다':String(error).includes('SOMI_NO_IMAGES')?'이미지가 없는 게시글입니다':'소미를 불러오지 못했습니다';

export function Somi({active,visible=active,paused,backRef,onSourceChange,onReady,bookmarked=false,source=bookmarked?'bookmarked':'somi',bookmarkSwitch}:{bookmarked?:boolean;source?:CatalogSource;bookmarkSwitch?:ReactNode;active:boolean;visible?:boolean;paused:boolean;backRef:MutableRefObject<(()=>boolean)|null>;onSourceChange(source:CatalogSource):void;onReady?():void}){
  const privacy=useTabletCatalogMasked();
  const [status,setStatus]=useState<SomiStatus|null>(null),[message,setMessage]=useState(''),[sheet,setSheet]=useState(false),[searchOpen,setSearchOpen]=useState(false);
  const [modeOptions,setModeOptions]=useState<Options[]>([{query:'',sort:'new',days:null,bookmarked:false},{query:'',sort:'added',days:null,bookmarked:true}]);
  const mode=bookmarked?1:0,options=modeOptions[mode];
  const cachedSlots=useRef<(number|null)[]>([null,null]),scrollPositions=useRef([0,0]);
  const restoreScroll=useRef<number|null>(null),previousMode=useRef(bookmarked);
  const [views,setViews]=useState<(View|null)[]>([null,null,null,null]),[shown,setShown]=useState(0),[pending,setPending]=useState<number|null>(null);
  const [busy,setBusy]=useState(false),[reader,setReader]=useState<Opened|null>(null),[opening,setOpening]=useState(false),[bookmarkPending,setBookmarkPending]=useState(new Set<string>());
  const statusRef=useRef(status);statusRef.current=status;const optionsRef=useRef(options);optionsRef.current=options;
  const current=views[shown],currentRef=useRef(current);currentRef.current=current;const shownRef=useRef(shown);shownRef.current=shown;
  const generation=useRef(0),session=useRef(0),loading=useRef(false),alive=useRef(true),requested=useRef(active&&!paused);requested.current=active&&!paused;
  const filled=useRef<number|null>(null),bookmarkBusy=useRef(new Set<string>()),readerRef=useRef(reader);readerRef.current=reader;
  const openingRef=useRef(false),loggingOut=useRef(false);
  const section=useRef<HTMLElement>(null),list=useRef<HTMLDivElement>(null),grids=[useRef<HTMLDivElement>(null),useRef<HTMLDivElement>(null),useRef<HTMLDivElement>(null),useRef<HTMLDivElement>(null)],release=useRef<(()=>void)|null>(null);
  const collecting=useDelayedBusy(!!status?.loggedIn&&status.syncing&&!status.complete);
  useLayoutEffect(()=>{if(active&&(status?.loggedIn===false||(!busy&&current&&current.options.bookmarked===bookmarked)||message))onReady?.();},[active,status?.loggedIn,busy,current,message,onReady,bookmarked]);
  useLevelMotion(section,visible?'somi':null,0);
  const clear=useCallback(()=>{session.current++;generation.current++;loading.current=false;setBusy(false);setPending(null);cachedSlots.current=[null,null];setViews([null,null,null,null]);setReader(null);setStatus(old=>old?{...old,loggedIn:false}:null);statusRef.current=null;},[]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;release.current?.();};},[]);
  useEffect(()=>{if(!message)return;const timer=window.setTimeout(()=>setMessage(''),4000);return()=>window.clearTimeout(timer);},[message]);
  const fail=useCallback((error:unknown)=>{if(String(error).includes('SOMI_LOGIN_REQUIRED'))clear();else setMessage(errorText(error));},[clear]);
  const load=useCallback(async(next:Options,more=false)=>{
    if(!requested.current||!statusRef.current?.loggedIn||next.bookmarked!==optionsRef.current.bookmarked||(more&&loading.current))return;
    const request=++generation.current,previous=currentRef.current;
    let page=more&&previous?previous.page+1:1;
    loading.current=true;setBusy(true);setPending(null);
    try{
      const result=await native<SomiSearchPage>('somiSearch',{...next,page});
      // Reconciliation refreshes the loaded range so it does not collapse a scrolled list to page one.
      const retain=!more&&previous&&sameOptions(previous.options,next)?previous.page:1;
      let incoming=result.items;
      while(!more&&page<retain&&result.items.length<result.total){
        if(!alive.current||request!==generation.current)return;
        const batch=await native<SomiSearchPage>('somiSearch',{...next,page:page+1});page++;
        incoming=batch.items;if(!incoming.length)break;
        result.items.push(...incoming.filter(p=>!result.items.some(old=>old.id===p.id)));
      }
      await prepareCatalogCovers(result.items.slice(0,12).map(p=>({provider:'kHentai' as const,providerWorkId:p.id,thumbnailUrl:p.cover})),'somi',new AbortController().signal,250);
      if(!alive.current||request!==generation.current)return;
      const items=more&&previous?[...previous.result.items,...result.items.filter(p=>!previous.result.items.some(old=>old.id===p.id))]:result.items;
      const base=next.bookmarked?2:0,slot=shownRef.current===base?base+1:base;
      setViews(old=>{const value=[...old];value[slot]={result:{...result,items},options:next,page,generation:request,fillIds:incoming.filter(p=>!p.cover&&p.coverKey).map(p=>p.id)};return value;});setPending(slot);
    }catch(error){if(alive.current&&request===generation.current){loading.current=false;setBusy(false);fail(error);}}
  },[fail]);
  useLayoutEffect(()=>{
    if(pending===null)return;const host=grids[pending].current;if(!host)return;
    release.current?.();return waitForViewportImages(host,()=>{
      const next=views[pending],previous=currentRef.current;
      if(next){
        const nextMode=next.options.bookmarked?1:0,priorMode=previous?.options.bookmarked?1:0;
        if(list.current&&nextMode!==priorMode){scrollPositions.current[priorMode]=list.current.scrollTop;restoreScroll.current=scrollPositions.current[nextMode];}
        else if(previous&&!sameOptions(next.options,previous.options))restoreScroll.current=0;
        cachedSlots.current[nextMode]=pending;
      }
      setShown(pending);setPending(null);loading.current=false;setBusy(false);
    },250,late=>{release.current=revealTogether(late,1500);});
  },[pending,views]);
  useEffect(()=>{
    if(!requested.current||privacy||busy||!current||filled.current===current.generation||current.generation!==generation.current)return;filled.current=current.generation;
    if(!current.fillIds.length)return;const request=current.generation,slot=shown,controller=new AbortController();
    const ids=current.fillIds;
    // The native side answers only after every cover of a call is downloaded, so ask in small
    // batches: covers appear as they arrive instead of all at once after up to a minute.
    void (async()=>{for(let start=0;start<ids.length;start+=FILL_BATCH){
      const covers=await native<{id:string;cover:string}[]>('somiFillCovers',{ids:ids.slice(start,start+FILL_BATCH)},controller.signal,120_000);
      if(controller.signal.aborted||!alive.current||!requested.current||request!==generation.current)return;const resolved=new Map(covers.map(c=>[c.id,c.cover]));
      setViews(old=>{const view=old[slot];if(!view||view.generation!==request)return old;const next=[...old];next[slot]={...view,result:{...view.result,items:view.result.items.map(p=>resolved.has(p.id)?{...p,cover:resolved.get(p.id)!}:p)}};return next;});
    }})().catch(()=>{});
    return()=>{controller.abort();if(filled.current===request)filled.current=null;};
  },[current?.generation,busy,shown,active,paused,privacy]);
  const check=useCallback(async(collect=false)=>{
    const epoch=session.current;
    try{const next=await native<SomiStatus>('somiStatus',{collect},undefined,70_000);if(!alive.current||epoch!==session.current)return;
      const previous=statusRef.current;statusRef.current=next;setStatus(next);
      if(!next.loggedIn){clear();setStatus(next);statusRef.current=next;}
      else if(collect||!currentRef.current||previous?.collected!==next.collected||(previous?.syncing&&!next.syncing))void load(optionsRef.current);
    }catch(error){if(alive.current&&epoch===session.current)fail(error);}
  },[load,clear,fail]);
  useEffect(()=>{if(!active||paused)return;void check(true);const resume=()=>void check(true);const update=(event:Event)=>{
    const next=(event as CustomEvent<SomiStatus>).detail;if(!next||loggingOut.current)return;
    const old=statusRef.current;statusRef.current=next;setStatus(next);
    if(!next.loggedIn){clear();setStatus(next);statusRef.current=next;}
    else if(!loading.current&&(!currentRef.current||old?.collected!==next.collected||(old?.syncing&&!next.syncing)))void load(optionsRef.current);
  };const shared=()=>{if(statusRef.current?.loggedIn)void load(optionsRef.current);};window.addEventListener('lakomics-resume',resume);window.addEventListener('lakomics-somi',update);window.addEventListener('lakomics-somi-state',shared);return()=>{window.removeEventListener('lakomics-resume',resume);window.removeEventListener('lakomics-somi',update);window.removeEventListener('lakomics-somi-state',shared);};},[active,paused,check,load,clear]);
  useLayoutEffect(()=>{
    const changed=previousMode.current!==bookmarked;previousMode.current=bookmarked;
    if(changed){generation.current++;loading.current=false;setBusy(false);setPending(null);setSheet(false);setSearchOpen(false);setReader(null);}
    if(!active||paused||(!changed&&currentRef.current?.options.bookmarked===bookmarked))return;
    const cached=cachedSlots.current[mode];
    if(cached!==null){
      if(list.current&&currentRef.current?.options.bookmarked!==bookmarked){scrollPositions.current[1-mode]=list.current.scrollTop;restoreScroll.current=scrollPositions.current[mode];}
      const request=++generation.current;
      setViews(old=>old.map((view,slot)=>slot===cached&&view?{...view,generation:request,fillIds:view.result.items.filter(post=>!post.cover&&post.coverKey).map(post=>post.id)}:view));
      setShown(cached);
    }else if(statusRef.current?.loggedIn&&!loading.current)void load(optionsRef.current);
  },[active,paused,bookmarked,load]);
  useLayoutEffect(()=>{if(restoreScroll.current!==null&&list.current){list.current.scrollTop=restoreScroll.current;restoreScroll.current=null;}},[shown]);
  const apply=(patch:Partial<Options>)=>{const next={...optionsRef.current,...patch};optionsRef.current=next;setModeOptions(old=>old.map((value,index)=>index===mode?next:value));void load(next);};
  const toggle=async(post:SomiPost)=>{
    if(bookmarkBusy.current.has(post.id))return;const epoch=session.current;bookmarkBusy.current.add(post.id);setBookmarkPending(new Set(bookmarkBusy.current));
    if(!bookmarked)cachedSlots.current[1]=null;
    try{const reply=await native<{bookmarked:boolean}>('somiBookmark',{id:post.id});if(!alive.current||epoch!==session.current)return;
      setViews(old=>old.map(view=>view?{...view,result:{...view.result,items:view.result.items.map(p=>p.id===post.id?{...p,bookmarked:reply.bookmarked}:p)}}:null));
      setReader(old=>old?.id===post.id?{...old,post:{...old.post,bookmarked:reply.bookmarked}}:old);
      if(optionsRef.current.bookmarked)void load(optionsRef.current);
    }catch(error){if(epoch===session.current)fail(error);}finally{bookmarkBusy.current.delete(post.id);if(alive.current)setBookmarkPending(new Set(bookmarkBusy.current));}
  };
  const open=async(post:SomiPost)=>{if(openingRef.current||privacy)return;openingRef.current=true;setOpening(true);const epoch=session.current,readingBookmarks=bookmarked;try{const result=await native<OpenResponse>('somiOpen',{id:post.id},undefined,70_000);if(alive.current&&requested.current&&epoch===session.current&&optionsRef.current.bookmarked===readingBookmarks)setReader({...result,id:post.id,post});}catch(error){if(epoch===session.current){fail(error);if(String(error).includes('SOMI_POST_GONE'))void load(optionsRef.current);}}finally{openingRef.current=false;if(alive.current)setOpening(false);}};
  const closeReader=useCallback(()=>{setReader(null);void native('somiFlush').catch(()=>{});},[]);
  useEffect(()=>{if(!active)return;backRef.current=()=>{if(readerRef.current){closeReader();return true;}if(sheet){setSheet(false);return true;}if(searchOpen){setSearchOpen(false);return true;}return false;};return()=>{backRef.current=null;};},[active,backRef,sheet,searchOpen,closeReader]);
  const scope=useSectionShade<CatalogSource>({label:'카탈로그 출처',options:CATALOG_SOURCES,value:source,onChange:onSourceChange,extra:<div className="ui-segmented ui-segmented--full-width catalog-view-controls"><button className="ui-segmented__cell" aria-haspopup="dialog" onClick={()=>setSheet(true)}><Squares2X2Icon aria-hidden="true"/>보기</button></div>},{active:active&&!paused&&!reader&&!sheet});
  const bookmarkPost=current?.result.items.find(p=>p.id===reader?.id)??reader?.post;
  const menu={title:'소미',entries:[{id:'somi-refresh',group:'action' as const,label:'새 글 확인',icon:<ArrowPathIcon/>,disabled:!status?.loggedIn||status.syncing,run:()=>{void native<SomiStatus>('somiRefresh').then(setStatus).catch(fail);}},{id:'somi-logout',icon:<ArrowRightOnRectangleIcon/>,group:'action' as const,label:'로그아웃',disabled:!status?.loggedIn,run:()=>{loggingOut.current=true;clear();void native('somiLogout').catch(()=>setMessage('코네 로그아웃을 완료하지 못했습니다')).finally(()=>{loggingOut.current=false;});}}]};
  return <section ref={section} className="mobile-catalog somi" style={{display:visible?'flex':'none'}} aria-label="소미">
    {searchOpen?<TopBarSearch title="소미 검색" onClose={()=>{setSearchOpen(false);apply({query:''});}}><input aria-label="제목·작가 검색" autoFocus value={options.query} placeholder="제목·작가 검색" onChange={e=>apply({query:e.target.value})}/></TopBarSearch>:<TopBar title={scope.title('카탈로그')} count={current?.result.total} barRef={scope.barRef} loading={(busy||opening)&&'소미 불러오는 중'} search={{scope:'소미',run:query=>{setSearchOpen(true);apply({query});}}} menu={menu}/>}
    {!searchOpen&&scope.shade}
    <div className="catalog-scroll" ref={list} onScroll={event=>{const el=event.currentTarget;if(!busy&&current&&current.result.items.length<current.result.total&&el.scrollHeight-el.scrollTop-el.clientHeight<600)void load(current.options,true);}}>
      {scope.inline}
      {bookmarkSwitch}
      {collecting&&<p className="hint" role="status">목차 모으는 중 {status?.collected??0} / {status?.total??'…'}</p>}
      {status?.loggedIn===false?<EmptyState title="코네 로그인이 필요합니다" action={<Button onClick={()=>void native('somiLogin').catch(fail)}>코네 로그인</Button>}/>:!status?message?<EmptyState title="소미를 불러오지 못했습니다" action={<Button onClick={()=>{setMessage('');void check(true);}}>다시 시도</Button>}/>:<div role="status" aria-label="소미 준비 중"/>:<>
        <div className="somi-results">{views.map((view,slot)=>view&&<div key={slot} ref={grids[slot]} className="somi-list-slot" aria-hidden={slot!==shown} inert={!active||paused||slot!==shown||busy||current?.options.bookmarked!==bookmarked} style={{display:slot===shown||slot===pending?'block':'none',visibility:slot===shown?'visible':'hidden',position:slot===shown?'relative':'absolute',top:0,left:0}}>
          {view.result.items.length?<div className="catalog-grid">{view.result.items.map(post=><CatalogCard key={post.id} arriving={false} onArrived={()=>{}} disabled={!active||paused||opening||busy||slot!==shown||current?.options.bookmarked!==bookmarked} onClick={()=>void open(post)} action={<BookmarkToggle form="corner" className="somi-card-bookmark" label={post.bookmarked?'북마크 해제':'북마크'} bookmarked={post.bookmarked} disabled={!active||paused||busy||slot!==shown||current?.options.bookmarked!==bookmarked||bookmarkPending.has(post.id)} onClick={()=>void toggle(post)}/>}>{arrival=><><div className="catalog-cover"><CatalogCover item={{provider:'kHentai',providerWorkId:post.id,thumbnailUrl:post.cover}} revision="somi" active={active&&!paused&&slot===shown&&!reader} arrival={arrival}/></div><strong>{post.title}</strong><span>{post.writerName||post.writerHandle}</span></>}</CatalogCard>)}</div>:<EmptyState title="검색 결과 없음"/>}
        </div>)}</div>
        {current&&current.result.items.length<current.result.total&&<Button variant="ghost" disabled={busy} onClick={()=>void load(current.options,true)}>더 보기</Button>}
      </>}
    </div>
    {message&&<p className="catalog-reader-error" role="alert">{message}</p>}
    {sheet&&<BottomSheet title="소미 보기" onClose={()=>setSheet(false)}>
      <ViewOptionsSection title="정렬"><div role="radiogroup" aria-label="소미 정렬">{[...SORTS,...(options.bookmarked?[{value:'added' as SomiSort,label:'추가순'}]:[])].map(option=><button key={option.value} className="sheet-option" role="radio" aria-checked={options.sort===option.value} onClick={()=>apply({sort:option.value})}>{option.label}<span className="radio-dot"/></button>)}</div></ViewOptionsSection>
      <ViewOptionsSection title="기간"><SegmentedControl label="소미 기간" fullWidth value={options.days===null?'all':String(options.days)} options={PERIODS} onChange={value=>apply(value==='all'?{days:null}:{days:Number(value),sort:'votes'})}/></ViewOptionsSection>
    </BottomSheet>}
    {!privacy&&reader&&<CatalogReader key={reader.id} manifest={reader.manifest} title={reader.title} initialPage={reader.initialPage} onPage={page=>{void native('somiPage',{id:reader.id,page}).catch(()=>{});}} onClose={closeReader} refreshable={false} onRefresh={()=>{}} refreshing={opening} bookmark={bookmarkPost?{desired:bookmarkPost.bookmarked,pending:bookmarkPending.has(reader.id),disabled:false,failure:'',toggle:()=>void toggle(bookmarkPost)}:undefined}/>}
  </section>;
}
