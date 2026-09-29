import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowsUpDownIcon,MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {ArtistImage,EmptyArtists} from './Artists';
import {api} from './transport';
import {SegmentedControl} from './ui';
import {usePrivacyMode} from './privacyMode';
import {PinIcon} from './PinIcon';
import {artistName,assetsFromIds,matchesArtist,normalizeArtists,sortArtists,type ArtistSort,type LibraryArtist} from './artistsModel';

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
  const assets = assetsFromIds(artist.coverAssetIds).slice(0,3);
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

export function ArtistGrid({active,paused,onOpenArtist,onVisibleNames}:{active:boolean;paused:boolean;onOpenArtist(artist:LibraryArtist):void;onVisibleNames?(names:string[]):void}) {
  const [privateMode] = usePrivacyMode();
  const [state,setState] = useState<'idle'|'loading'|'ready'|'empty'>('idle');
  const [artists,setArtists] = useState<LibraryArtist[]>([]);
  const [query,setQuery] = useState('');
  const [sort,setSort] = useState<ArtistSort>(readSort);
  const [sortOpen,setSortOpen] = useState(false);
  const request = useRef<AbortController|null>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!active || state !== 'idle' || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState('loading');
    void api<unknown>('/v1/library/artists',controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const next = normalizeArtists(value);
      setArtists(next);
      setState(next.length ? 'ready' : 'empty');
    }, () => {
      if (!controller.signal.aborted) setState('empty');
    }).finally(() => {
      if (request.current === controller) request.current = null;
    });
  }, [active,state]);

  const visible = useMemo(() => {
    const candidates = query.trim()
      ? artists.filter(artist => matchesArtist(artist,query))
      : artists.some(artist => artist.main) ? artists.filter(artist => artist.main) : artists;
    return sortArtists(candidates,sort);
  }, [artists,query,sort]);
  useEffect(() => { onVisibleNames?.(visible.map(artistName)); }, [onVisibleNames,visible]);

  const chooseSort = (value:ArtistSort) => {
    setSort(value);
    try { localStorage.setItem(ARTIST_SORT_KEY,value); } catch { /* Optional device preference. */ }
    setSortOpen(false);
  };

  return <div className="artist-grid-pane" aria-label="작가 목록">
    <div className="artist-grid-toolbar">
      <label className="artist-grid-search"><MagnifyingGlassIcon aria-hidden="true"/><span className="sr-only">작가 찾기</span><input type="search" aria-label="작가 찾기" placeholder="작가 찾기" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button type="button" className="artist-grid-sort" aria-label={`정렬: ${SORT_LABELS[sort]}`} onClick={() => setSortOpen(true)}><ArrowsUpDownIcon aria-hidden="true"/>{SORT_LABELS[sort]}</button>
    </div>
    {state === 'idle' || state === 'loading' ? <div className="artist-empty" role="status"><span>{state === 'loading' ? '작가 목록을 불러오는 중입니다' : '작가 목록을 준비하는 중입니다'}</span></div> : state === 'empty' ? <EmptyArtists/> : visible.length ? <div className="artist-grid-list">{visible.map(artist => <ArtistGridCard key={artist.id} artist={artist} privateMode={privateMode} paused={paused} onOpen={() => onOpenArtist(artist)}/>)}</div> : <div className="artist-empty"><h2>검색 결과가 없습니다</h2><p>이름, 핸들 또는 초성을 바꿔 보세요.</p></div>}
    {sortOpen && <BottomSheet title="정렬" onClose={() => setSortOpen(false)}><SegmentedControl fullWidth label="작가 정렬" options={SORT_OPTIONS} value={sort} onChange={chooseSort}/></BottomSheet>}
  </div>;
}
