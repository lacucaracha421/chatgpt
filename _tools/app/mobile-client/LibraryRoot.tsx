import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ChevronRightIcon,MagnifyingGlassIcon,PhotoIcon,TrashIcon} from '@heroicons/react/24/outline';
import {IconButton} from './ui';
import {Cover} from './CoverGroup';
import {FolderCards,characterCovers,useFolderCovers} from './FolderCards';
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
    <span className="result-name"><strong><Highlight name={entry.name} query={query}/></strong><small>{(entry.characterKind==='character'?'캐릭터 · ':entry.characterKind==='group'?'캐릭터 그룹 · ':'')}{path}</small></span>
    <span className="numeric muted">{entry.asset_count}</span><ChevronRightIcon/>
  </button>;
}
export function LibraryRoot({active=true,entries,characters,recentFolders,items,total,paused,busy,revision,onSelect,onRefresh,albumTree,albumError,segment,onSegment,restoreScroll,onScroll,review,similarity,onTrash}:{/** False while a folder is open: the root stays mounted, hidden, so going back is instant. */active?:boolean;/** Opens the Library Trash; absent until the lifecycle authority is adopted. */onTrash?():void;review?:{enabled:boolean;refreshKey:unknown;onOpen():void};similarity?:{enabled:boolean;refreshKey:unknown;onOpen():void};entries:Entry[];characters?:CharacterIndex;recentFolders:string[];items:Asset[];total?:number;paused:boolean;busy:boolean;revision:number;onSelect(view:View):void;onRefresh():void;albumTree:AlbumTree|null;albumError:string;segment:'folders'|'albums';onSegment(segment:'folders'|'albums'):void;restoreScroll:number;onScroll(top:number):void}) {
  const [query,setQuery]=useState('');
  const host=useRef<HTMLDivElement>(null),pull=usePullToRefresh(host,onRefresh,busy,paused);
  useLayoutEffect(()=>{if(active&&host.current)host.current.scrollTop=restoreScroll;},[restoreScroll,active]);
  const recent=recentFolders.map(id=>entries.find(entry=>entry.id===id)).filter((entry):entry is Entry=>!!entry);
  const path=(entry:Entry)=>ancestorsOf(entries,entry.id).map(item=>item.name).join(' › ')||'최상위';
  const results=searchLibraryEntries(entries,query);
  const rows=query.trim()?results:[];
  const {covers,onVisible}=useFolderCovers(rows,paused||segment==='albums',revision);
  return <div className="library-root" style={{display:active?undefined:'none'}}><header className={`library-root-header${onTrash?' with-tools':''}`}><h1>라이브러리</h1>{onTrash&&<IconButton label="휴지통" icon={TrashIcon} onClick={onTrash}/>}</header><div className="library-root-scroll" ref={host} onScroll={event=>onScroll(event.currentTarget.scrollTop)} aria-label="라이브러리 탐색">{pull}
    {similarity&&<SimilarityReviewEntry enabled={similarity.enabled&&!paused} refreshKey={similarity.refreshKey} onOpen={similarity.onOpen}/>}
    <div className="library-segments" role="tablist" aria-label="라이브러리 보기">{(['folders','albums'] as const).map(value=><button key={value} role="tab" aria-selected={segment===value} onClick={()=>{onSegment(value);setQuery('');}}>{value==='folders'?'분류':'앨범'}</button>)}</div>
    <label className="library-search"><MagnifyingGlassIcon/><input type="search" aria-label={segment==='albums'?'앨범 찾기':'폴더·캐릭터 찾기'} placeholder={segment==='albums'?'앨범 찾기':'폴더·캐릭터 찾기'} value={query} onChange={event=>setQuery(event.target.value)}/></label>
    {segment==='albums'?<>{albumError&&<p className="error-message">{albumError}</p>}{albumTree&&<Albums key={`${albumTree.libraryId}:${albumTree.epoch}`} tree={albumTree} revision={revision} query={query} paused={paused} onSelect={onSelect}/>}</>:query.trim()?<div className="library-results">{results.map(entry=><FolderRow key={entry.id} entry={entry} query={query} path={path(entry)} cover={characterCovers(entry,characters)[0]??covers[entry.id]?.[0]} paused={paused} onVisible={onVisible} onSelect={onSelect}/>)}{!searchLibraryEntries(entries,query).length&&<p className="hint">일치하는 폴더가 없습니다.</p>}</div>:<>
    {!!recent.length&&<section><h2>최근 연 폴더</h2><div className="library-recents">{recent.map(entry=><button key={entry.id} onClick={()=>onSelect(entryView(entry))}>{entry.name}</button>)}</div></section>}
    <button className="library-all" onClick={()=>onSelect(ALL_ASSETS)}><span className="all-covers">{items.slice(0,4).map(asset=><Cover key={asset.id} asset={asset} paused={paused}/>)}</span><span className="result-name"><strong>모든 자산</strong><small>최근 저장한 순서</small></span>{total!==undefined&&<span className="numeric muted">{total}</span>}<ChevronRightIcon/></button>
    <section><h2>분류</h2>{review&&<CharacterReviewEntry enabled={review.enabled&&!paused} refreshKey={review.refreshKey} onOpen={review.onOpen}/>}<FolderCards items={entries.filter(entry=>!entry.parent_id)} entries={entries} characters={characters} paused={paused} revision={revision} onSelect={onSelect}/>{!entries.length&&<p className="hint">아직 게시된 분류가 없습니다.</p>}</section>
    </>}
  </div></div>;
}
