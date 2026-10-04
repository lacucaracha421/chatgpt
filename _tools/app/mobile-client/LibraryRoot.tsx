import {useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type React from 'react';
import {ChevronDownIcon,ChevronRightIcon,TrashIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {SearchButton,TopBar} from './TopBar';
import {useSimilarityReviewCount} from './useSimilarityReview';
import {IconButton,SectionLabel} from './ui';
import {useSectionShade} from './SectionShade';
import {Cover} from './CoverGroup';
import {FolderCards} from './FolderCards';
import {ALL_ASSETS,type Entry} from './libraryModel';
import {Albums,type AlbumTree} from './Albums';
import {usePullToRefresh} from './usePullToRefresh';
import type {Asset,View} from './types';
import type {CharacterIndex} from './characterModel';
import {SimilarityReviewEntry} from './SimilarityReview';
import {Scrubber} from './Scrubber';
import {AssetSearch} from './AssetSearch';
import {assetSuggestions,type AssetSuggestion} from './assetSearchModel';
import {useLibraryArtists} from './useLibraryArtists';
import {ArtistGrid} from './ArtistGrid';
import {HiddenArtists} from './Artists';
import type {LibraryArtist} from './artistsModel';

export type LibrarySegment = 'folders'|'albums'|'artists';
const SEGMENTS:readonly {value:LibrarySegment;label:string}[]=[{value:'folders',label:'분류'},{value:'albums',label:'앨범'},{value:'artists',label:'작가'}];
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
export function LibraryRoot({active=true,entries,characters,items,total,paused,busy,revision,onSelect,onOpenArtist,onSearchSelect,onSearchFocus,endpoint='',onRefresh,albumTree,albumError,albumLoading=false,segment,onSegment,restoreScroll,onScroll,similarity,onTrash}:{/** False while a folder is open: the root stays mounted, hidden, so going back is instant. */active?:boolean;/** Opens the Library Trash; absent until the lifecycle authority is adopted. */onTrash?():void;similarity?:{enabled:boolean;refreshKey:unknown;scope?:string;onOpen():void};entries:Entry[];characters?:CharacterIndex;items:Asset[];total?:number;paused:boolean;busy:boolean;revision:number;onSearchSelect?(item:AssetSuggestion):void;onSearchFocus?():void;endpoint?:string;onSelect(view:View):void;onOpenArtist(artist:LibraryArtist):void;onRefresh():void;albumTree:AlbumTree|null;albumError:string;albumLoading?:boolean;segment:LibrarySegment;onSegment(segment:LibrarySegment):void;restoreScroll:number;onScroll(top:number):void}) {
  const [searchOpen,setSearchOpen]=useState(false);
  const [queueOpen,setQueueOpen]=useState(false);
  const [artistNames,setArtistNames]=useState<string[]>([]);
  // The end line describes the first screen only; it leaves once the user scrolls.
  const [scrolled,setScrolled]=useState(false);
  const host=useRef<HTMLDivElement>(null),pull=usePullToRefresh(host,onRefresh,busy,paused);
  const folders=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{if(active&&host.current)host.current.scrollTop=restoreScroll;},[restoreScroll,active]);
  // Waiting review work is one quiet "확인 N" in the bar, shown only while something waits.
  const similarityCount=useSimilarityReviewCount(!!similarity?.enabled&&active&&!paused,similarity?.refreshKey,similarity?.scope)??0;
  const waiting=similarityCount;
  const openQueue=()=>setQueueOpen(true);
  const topFolders=entries.filter(entry=>!entry.parent_id);
  const showFolders=segment==='folders'&&!searchOpen;
  const fit=useFolderFit(active&&showFolders,host,folders,`${topFolders.length}:${!!waiting}`);
  const [listsRequested,setListsRequested]=useState(false);
  const artistList=useLibraryArtists(active&&!paused&&(listsRequested||segment==='artists'),revision,endpoint);
  const suggestions=useMemo(()=>assetSuggestions(entries,characters,albumTree,artistList.artists),[entries,characters,albumTree,artistList.artists]);
  const closeSearch=()=>setSearchOpen(false);
  const openSearch=()=>{setSearchOpen(true);setListsRequested(true);onSearchFocus?.();};
  const chooseSuggestion=(item:AssetSuggestion)=>{if(onSearchSelect)onSearchSelect(item);else if(item.kind==='artist')onOpenArtist(item.artist);else if(item.kind!=='tag')onSelect(item.view);};
  const albumItems=useMemo(()=>{
    if(!albumTree)return [];
    const known=new Set(albumTree.albums.map(album=>album.id));
    return albumTree.albums.filter(album=>!album.parentId||!known.has(album.parentId));
  },[albumTree]);
  const scrubberValues=segment==='artists'?artistNames:segment==='albums'?albumItems.map(album=>album.name):topFolders.map(entry=>entry.name);
  const scrubberSort=useMemo(()=>segment==='artists'?({kind:'name',values:artistNames} as const):({kind:'fallback'} as const),[artistNames,segment]);
  // 분류 · 앨범 · 작가 is the list's first row; scrolled away, the top bar pulls it down.
  const chooseSegment=(value:LibrarySegment)=>{onSegment(value);setSearchOpen(false);};
  const sections=useSectionShade<LibrarySegment>({label:'에셋 보기',options:SEGMENTS,value:segment,onChange:chooseSegment},{active:active&&!paused});
  const onVisibleArtistNames=useCallback((names:string[])=>setArtistNames(previous=>previous.length===names.length&&previous.every((name,index)=>name===names[index])?previous:names),[]);
  return <div className={`library-root${fit?' is-fit':''}`} style={{display:active?undefined:'none',...(fit?{'--root-cover-height':`${fit.cover}px`} as React.CSSProperties:{})}}>
    {searchOpen&&<AssetSearch items={suggestions} endpoint={endpoint} paused={paused} loading={busy||albumLoading||artistList.state==='idle'||artistList.state==='loading'} onClose={closeSearch} onChoose={chooseSuggestion} error={albumError||artistList.error} onRetry={()=>{onRefresh();artistList.retry();}}/>}
    <div style={{display:searchOpen?'none':undefined}} className="library-root-content">
    <TopBar barRef={sections.barRef} title={sections.title('에셋')} loading={busy&&'목록 불러오는 중'} actions={<>{waiting>0&&<button className="top-bar__queue" onClick={openQueue} aria-label={`확인할 것 ${waiting}개`}>확인<span className="numeric">{waiting}</span></button>}<SearchButton onClick={openSearch}/>{onTrash&&<IconButton label="휴지통" icon={TrashIcon} onClick={onTrash}/>}</>}/>
    {sections.shade}
    <div className="library-root-scroll" ref={host} onScroll={event=>{const top=event.currentTarget.scrollTop;onScroll(top);if(top>8!==scrolled)setScrolled(top>8);}} aria-label="에셋 탐색">{pull}
    {sections.inline}
    <div style={{display:segment==='folders'?undefined:'none'}}>
      <button className="library-all" onClick={()=>onSelect(ALL_ASSETS)}><span className="all-covers">{items.slice(0,4).map(asset=><Cover key={asset.id} asset={asset} paused={paused||segment!=='folders'}/>)}</span><span className="result-name"><strong>모든 자산</strong><small>최근 저장한 순서</small></span>{total!==undefined&&<span className="numeric muted">{total}</span>}<ChevronRightIcon/></button>
      <section className="library-root-folders" ref={folders}><SectionLabel as="h2" className="section-label" title="분류" count={topFolders.length ? topFolders.length : undefined}/><FolderCards items={topFolders} entries={entries} characters={characters} paused={paused||!active||segment!=='folders'||searchOpen} revision={revision} onSelect={onSelect}/>{!entries.length&&<p className="hint">아직 게시된 분류가 없습니다.</p>}
      {fit&&fit.hidden>0&&!scrolled&&<p className="library-end-line"><ChevronDownIcon aria-hidden="true"/>아래에 분류 {fit.hidden}개 더</p>}</section>
    </div>
    <div style={{display:segment==='albums'?undefined:'none'}}>
      {albumError&&<p className="error-message">{albumError}</p>}
      {albumTree&&<Albums key={`${albumTree.libraryId}:${albumTree.epoch}`} tree={albumTree} revision={revision} paused={paused||!active||segment!=='albums'||searchOpen} onSelect={onSelect}/>}
    </div>
    <div style={{display:segment==='artists'?undefined:'none'}}><HiddenArtists endpoint={endpoint} artists={artistList.allArtists} onOpen={onOpenArtist} pending={artistList.pending} syncError={artistList.error} onRetry={artistList.retry}/><ArtistGrid artists={artistList.artists} state={artistList.state} paused={paused||!active||segment!=='artists'||searchOpen} onOpenArtist={onOpenArtist} onVisibleNames={onVisibleArtistNames}/></div>
    <Scrubber scrollRef={host} total={scrubberValues.length} sort={scrubberSort} hidden={!active||paused||queueOpen||searchOpen}/>
  </div>
  </div>
  {queueOpen&&<BottomSheet title="확인할 것" onClose={()=>setQueueOpen(false)}>
    {similarity&&<SimilarityReviewEntry enabled={similarity.enabled&&active&&!paused} refreshKey={similarity.refreshKey} onOpen={()=>{setQueueOpen(false);similarity.onOpen();}}/>}
  </BottomSheet>}
  </div>;
}
