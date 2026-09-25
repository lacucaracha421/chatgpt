import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type React from 'react';
import {ChevronDownIcon,ChevronRightIcon,MagnifyingGlassIcon,PhotoIcon,TrashIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {SearchButton,TopBar,TopBarSearch} from './TopBar';
import {useCharacterReviewCount} from './useCharacterReview';
import {useSimilarityReviewCount} from './useSimilarityReview';
import {IconButton} from './ui';
import {Cover} from './CoverGroup';
import {CharacterGlyph,FolderCards,characterCovers,characterKindOf,useFolderCovers} from './FolderCards';
import {ALL_ASSETS,ancestorsOf,entryView,searchLibraryEntries,type Entry} from './libraryModel';
import {Albums,type AlbumTree} from './Albums';
import {usePullToRefresh} from './usePullToRefresh';
import type {Asset,View} from './types';
import type {CharacterIndex} from './characterModel';
import {CharacterReviewEntry} from './CharacterReview';
import {SimilarityReviewEntry} from './SimilarityReview';
export function Highlight({name,query}:{name:string;query:string}) {
  const at=name.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  return at<0||!query.trim()?<>{name}</>:<>{name.slice(0,at)}<mark>{name.slice(at,at+query.trim().length)}</mark>{name.slice(at+query.trim().length)}</>;
}
function FolderRow({entry,path,query,cover,paused,onVisible,onSelect}:{entry:Entry;path:string;query:string;cover?:Asset;paused:boolean;onVisible(id:string,visible:boolean):void;onSelect(view:View):void}) {
  const host=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(false);
  useEffect(()=>{
    if(!host.current)return;
    if(!window.IntersectionObserver){setVisible(true);onVisible(entry.id,true);return;}
    const observer=new IntersectionObserver(records=>{const visible=records.some(r=>r.isIntersecting);setVisible(visible);onVisible(entry.id,visible);},{rootMargin:'120px'});
    observer.observe(host.current);return()=>observer.disconnect();
  },[entry.id,onVisible]);
  return <button ref={host} aria-label={`${entry.name}, ${path}, ${entry.asset_count}개`} className="library-result" onClick={()=>onSelect(entryView(entry))}>
    {cover?<Cover asset={cover} paused={paused||!visible}/>:<span className="home-cover"><PhotoIcon className="missing-media"/></span>}
    <span className="result-name"><strong>{characterKindOf(entry)&&<CharacterGlyph kind={characterKindOf(entry)!}/>}<Highlight name={entry.name} query={query}/></strong><small>{(entry.characterKind==='character'?'캐릭터 · ':entry.characterKind==='group'?'캐릭터 그룹 · ':'')}{path}</small></span>
    <span className="numeric muted">{entry.asset_count}</span><ChevronRightIcon/>
  </button>;
}
/** Height of the "아래에 분류 N개 더" line under a fitted grid (matches `.library-end-line`). */
const END_LINE=32;
/** Cover height as a share of the card width that still reads as a cover: 4:3 up to square. */
const FIT_MIN=.72,FIT_MAX=1.02;
type Fit={cover:number;hidden:number};
/**
 * Sizes the top-level folder covers so the first screen ends on a whole row. Measured from the
 * real scroller on every resize, so it follows the device's actual viewport and inset height.
 */
function useFolderFit(active:boolean,scroller:React.RefObject<HTMLDivElement|null>,grid:React.RefObject<HTMLDivElement|null>,key:unknown):Fit|null {
  const [fit,setFit]=useState<Fit|null>(null);
  useLayoutEffect(()=>{
    const host=scroller.current;
    if(!active||!host){setFit(null);return;}
    const measure=()=>{
      const container=grid.current?.querySelector<HTMLElement>('.library-folder-grid');
      const cards=container?[...container.children] as HTMLElement[]:[];
      const cover=cards[0]?.querySelector<HTMLElement>('.home-cover-group');
      if(!container||!cover||!host.clientHeight||!cards[0].clientWidth){setFit(null);return;}
      const style=getComputedStyle(container);
      const columns=Math.max(1,style.gridTemplateColumns.split(' ').filter(Boolean).length);
      const rows=Math.ceil(cards.length/columns),gap=parseFloat(style.rowGap)||0,width=cards[0].clientWidth;
      const caption=cards[0].getBoundingClientRect().height-cover.getBoundingClientRect().height;
      const top=container.getBoundingClientRect().top-host.getBoundingClientRect().top+host.scrollTop;
      const available=host.clientHeight-top-END_LINE;
      let next:Fit|null=null;
      for(const count of [3,2,4]){
        if(rows<count)continue;
        const height=Math.floor((available-(count-1)*gap)/count-caption);
        if(height>=width*FIT_MIN&&height<=width*FIT_MAX){next={cover:height,hidden:Math.max(0,cards.length-count*columns)};break;}
      }
      setFit(old=>old?.cover===next?.cover&&old?.hidden===next?.hidden?old:next);
    };
    measure();
    if(!window.ResizeObserver)return;
    const observer=new ResizeObserver(measure);observer.observe(host);if(grid.current)observer.observe(grid.current);
    return()=>observer.disconnect();
  },[active,scroller,grid,key]);
  return fit;
}
export function LibraryRoot({active=true,entries,characters,items,total,paused,busy,revision,onSelect,onRefresh,albumTree,albumError,segment,onSegment,restoreScroll,onScroll,review,similarity,onTrash}:{/** False while a folder is open: the root stays mounted, hidden, so going back is instant. */active?:boolean;/** Opens the Library Trash; absent until the lifecycle authority is adopted. */onTrash?():void;review?:{enabled:boolean;refreshKey:unknown;onOpen():void};similarity?:{enabled:boolean;refreshKey:unknown;onOpen():void};entries:Entry[];characters?:CharacterIndex;items:Asset[];total?:number;paused:boolean;busy:boolean;revision:number;onSelect(view:View):void;onRefresh():void;albumTree:AlbumTree|null;albumError:string;segment:'folders'|'albums';onSegment(segment:'folders'|'albums'):void;restoreScroll:number;onScroll(top:number):void}) {
  const [query,setQuery]=useState('');
  const [searchOpen,setSearchOpen]=useState(false);
  const [queueOpen,setQueueOpen]=useState(false);
  // The end line describes the first screen only; it leaves once the user scrolls.
  const [scrolled,setScrolled]=useState(false);
  const host=useRef<HTMLDivElement>(null),pull=usePullToRefresh(host,onRefresh,busy,paused);
  const folders=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{if(active&&host.current)host.current.scrollTop=restoreScroll;},[restoreScroll,active]);
  const path=(entry:Entry)=>ancestorsOf(entries,entry.id).map(item=>item.name).join(' › ')||'최상위';
  const results=searchLibraryEntries(entries,query);
  const rows=query.trim()?results:[];
  const {covers,onVisible}=useFolderCovers(rows,paused||segment==='albums',revision);
  // Waiting review work is one quiet "확인 N" in the bar, shown only while something waits.
  const characterCount=useCharacterReviewCount(!!review?.enabled&&!paused,null,review?.refreshKey)??0;
  const similarityCount=useSimilarityReviewCount(!!similarity?.enabled&&!paused,similarity?.refreshKey)??0;
  const waiting=characterCount+similarityCount;
  const openQueue=()=>{
    if(characterCount&&!similarityCount)review?.onOpen();
    else if(similarityCount&&!characterCount)similarity?.onOpen();
    else setQueueOpen(true);
  };
  const topFolders=entries.filter(entry=>!entry.parent_id);
  const showFolders=segment==='folders'&&!query.trim();
  const fit=useFolderFit(active&&showFolders,host,folders,`${topFolders.length}:${!!waiting}`);
  const searching=searchOpen||!!query;
  const closeSearch=()=>{setQuery('');setSearchOpen(false);};
  const label=segment==='albums'?'앨범 찾기':'폴더·캐릭터 찾기';
  return <div className={`library-root${fit?' is-fit':''}`} style={{display:active?undefined:'none',...(fit?{'--root-cover-height':`${fit.cover}px`} as React.CSSProperties:{})}}>
    {searching
      ?<TopBarSearch title="라이브러리" onClose={closeSearch}><label className="top-bar__search"><MagnifyingGlassIcon aria-hidden="true"/><input type="search" autoFocus aria-label={label} placeholder={label} value={query} onChange={event=>setQuery(event.target.value)}/></label>{query&&<IconButton label="검색어 지우기" icon={XMarkIcon} onClick={()=>setQuery('')}/>}</TopBarSearch>
      :<TopBar title="라이브러리" actions={<>{waiting>0&&<button className="top-bar__queue" onClick={openQueue} aria-label={`확인할 것 ${waiting}개`}>확인<span className="numeric">{waiting}</span></button>}<SearchButton onClick={()=>setSearchOpen(true)}/>{onTrash&&<IconButton label="휴지통" icon={TrashIcon} onClick={onTrash}/>}</>}/>}
    <div className="library-root-scroll" ref={host} onScroll={event=>{const top=event.currentTarget.scrollTop;onScroll(top);if(top>8!==scrolled)setScrolled(top>8);}} aria-label="라이브러리 탐색">{pull}
    <div className="library-segments" role="tablist" aria-label="라이브러리 보기">{(['folders','albums'] as const).map(value=><button key={value} role="tab" aria-selected={segment===value} onClick={()=>{onSegment(value);setQuery('');}}>{value==='folders'?'분류':'앨범'}</button>)}</div>
    {segment==='albums'?<>{albumError&&<p className="error-message">{albumError}</p>}{albumTree&&<Albums key={`${albumTree.libraryId}:${albumTree.epoch}`} tree={albumTree} revision={revision} query={query} paused={paused} onSelect={onSelect}/>}</>:query.trim()?<div className="library-results">{results.map(entry=><FolderRow key={entry.id} entry={entry} query={query} path={path(entry)} cover={characterCovers(entry,characters)[0]??covers[entry.id]?.[0]} paused={paused} onVisible={onVisible} onSelect={onSelect}/>)}{!searchLibraryEntries(entries,query).length&&<p className="hint">일치하는 폴더가 없습니다.</p>}</div>:<>
    <button className="library-all" onClick={()=>onSelect(ALL_ASSETS)}><span className="all-covers">{items.slice(0,4).map(asset=><Cover key={asset.id} asset={asset} paused={paused}/>)}</span><span className="result-name"><strong>모든 자산</strong><small>최근 저장한 순서</small></span>{total!==undefined&&<span className="numeric muted">{total}</span>}<ChevronRightIcon/></button>
    <section className="library-root-folders" ref={folders}><h2 className="section-label">분류{!!topFolders.length&&<span className="numeric">{topFolders.length}</span>}</h2><FolderCards items={topFolders} entries={entries} characters={characters} paused={paused} revision={revision} onSelect={onSelect}/>{!entries.length&&<p className="hint">아직 게시된 분류가 없습니다.</p>}
    {fit&&fit.hidden>0&&!scrolled&&<p className="library-end-line"><ChevronDownIcon aria-hidden="true"/>아래에 분류 {fit.hidden}개 더</p>}</section>
    </>}
  </div>
  {queueOpen&&<BottomSheet title="확인할 것" onClose={()=>setQueueOpen(false)}>
    {similarity&&<SimilarityReviewEntry enabled={similarity.enabled&&!paused} refreshKey={similarity.refreshKey} onOpen={()=>{setQueueOpen(false);similarity.onOpen();}}/>}
    {review&&<CharacterReviewEntry enabled={review.enabled&&!paused} refreshKey={review.refreshKey} onOpen={()=>{setQueueOpen(false);review.onOpen();}}/>}
  </BottomSheet>}
  </div>;
}
