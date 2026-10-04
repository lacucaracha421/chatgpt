import { useDelayedBusy } from "../src/shared/useDelayedBusy";
import {useFirstAppearance} from '../src/shared/motion/useFirstAppearance';
import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowsUpDownIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {ArtistImage,EmptyArtists} from './Artists';
import {ARTIST_LIST_ENTRANCE,PreparedCovers,usePreparedCovers} from './artistCovers';
import {EmptyState,SegmentedControl} from './ui';
import {usePrivacyMode} from './privacyMode';
import {PinIcon} from './PinIcon';
import {artistName,assetsFromIds,sortArtists,type ArtistSort,type LibraryArtist} from './artistsModel';

const SORT_LABELS: Record<ArtistSort,string> = {recent:'최근 저장 순',count:'장수',name:'이름'};
const SORT_OPTIONS = (Object.entries(SORT_LABELS) as [ArtistSort,string][]).map(([value,label]) => ({value,label}));
const ARTIST_SORT_KEY = 'lakomics.mobile.artistSort';

function readSort(): ArtistSort {
  try {
    const value = localStorage.getItem(ARTIST_SORT_KEY);
    if (value === 'recent' || value === 'count' || value === 'name') return value;
  } catch { /* Optional device preference. */ }
  return 'recent';
}

function ArtistGridCard({artist,privateMode,paused,onOpen}:{artist:LibraryArtist;privateMode:boolean;paused:boolean;onOpen():void}) {
  const assets = assetsFromIds(artist.coverAssetIds,artist.coverContentRatings).slice(0,3);
  const name = artistName(artist);
  return <button type="button" className="artist-grid-card" onClick={onOpen} aria-label={`${name}, ${artist.assetCount.toLocaleString('ko-KR')}장${artist.pinned ? ', 고정됨' : ''}`}>
    <span className="artist-grid-mosaic">
      <ArtistImage asset={assets[0]} privateMode={privateMode} paused={paused}/>
      <ArtistImage asset={assets[1]} privateMode={privateMode} paused={paused}/>
      <ArtistImage asset={assets[2]} privateMode={privateMode} paused={paused}/>
      {artist.pinned && <span className="artist-grid-pin" aria-label="고정된 작가"><PinIcon aria-hidden="true"/></span>}
    </span>
    <span className="artist-grid-caption"><strong className="artist-grid-name">{name}</strong><span className="artist-grid-count numeric muted">{artist.assetCount.toLocaleString('ko-KR')}</span></span>
  </button>;
}

export function ArtistGrid({artists,state,paused,onOpenArtist,onVisibleNames}:{artists:LibraryArtist[];state:'idle'|'loading'|'ready'|'empty';paused:boolean;onOpenArtist(artist:LibraryArtist):void;onVisibleNames?(names:string[]):void}) {
  const [privateMode] = usePrivacyMode();
  const [sort,setSort] = useState<ArtistSort>(readSort);
  const [sortOpen,setSortOpen] = useState(false);
  const visible = useMemo(() => sortArtists(artists.some(artist=>artist.main)?artists.filter(artist=>artist.main):artists,sort),[artists,sort]);
  const showLoading=useDelayedBusy(state==='idle'||state==='loading');
  const host=useRef<HTMLDivElement>(null);
  const firstScreen=useMemo(()=>visible.slice(0,12).flatMap(artist=>assetsFromIds(artist.coverAssetIds,artist.coverContentRatings).slice(0,3)),[visible]);
  const covers=usePreparedCovers(firstScreen,!paused&&state==='ready');
  // The cards and their thumbnails enter as one: the rise starts once the first screen's covers decode (capped).
  useFirstAppearance(host,visible.length,!paused&&state==='ready',"classification-artists",".artist-grid-card",undefined,ARTIST_LIST_ENTRANCE);
  useEffect(() => { onVisibleNames?.(visible.map(artistName)); }, [onVisibleNames,visible]);

  const chooseSort = (value:ArtistSort) => {
    setSort(value);
    try { localStorage.setItem(ARTIST_SORT_KEY,value); } catch { /* Optional device preference. */ }
    setSortOpen(false);
  };

  return <div ref={host} className="artist-grid-pane" aria-label="작가 목록">
    <div className="artist-grid-toolbar">
      <button type="button" className="artist-grid-sort" aria-label={`정렬: ${SORT_LABELS[sort]}`} onClick={() => setSortOpen(true)}><ArrowsUpDownIcon aria-hidden="true"/>{SORT_LABELS[sort]}</button>
    </div>
    {state === 'idle' || state === 'loading' || showLoading || state === 'ready' && !covers ? <div className="artist-empty" role="status"><span>{showLoading && "작가 목록을 불러오는 중입니다"}</span></div> : state === 'empty' ? <EmptyArtists/> : visible.length ? <PreparedCovers.Provider value={covers ?? new Map()}><div className="artist-grid-list">{visible.map(artist => <ArtistGridCard key={artist.id} artist={artist} privateMode={privateMode} paused={paused} onOpen={() => onOpenArtist(artist)}/>)}</div></PreparedCovers.Provider> : <EmptyState title="검색 결과가 없습니다"/>}
    {sortOpen && <BottomSheet title="정렬" onClose={() => setSortOpen(false)}><SegmentedControl fullWidth label="작가 정렬" options={SORT_OPTIONS} value={sort} onChange={chooseSort}/></BottomSheet>}
  </div>;
}
