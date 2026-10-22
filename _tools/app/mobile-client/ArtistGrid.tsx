import { useDelayedBusy } from "../src/shared/useDelayedBusy";
import {useFirstAppearance} from '../src/shared/motion/useFirstAppearance';
import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowsUpDownIcon,ChevronDownIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {ArtistActionSheet} from './ArtistActions';
import {useLongPress} from '../src/shared/useLongPress';
import {ArtistImage,EmptyArtists} from './Artists';
import {ARTIST_LIST_ENTRANCE,PreparedCovers,usePreparedCovers} from './artistCovers';
import {Button,EmptyState,SegmentedControl,Skeleton} from './ui';
import {FilterChip} from '../src/shared/ui/FilterChip';
import {readyFirstScreen} from './firstScreen';
import {useLibraryArtists} from './useLibraryArtists';
import {TabletHelp} from './TabletHelp';
import {usePrivacyMode} from './privacyMode';
import {PinSolidIcon} from '../src/shared/ui/PinIcon';
import {useArtistEntry} from './ArtistGridEntry';
import {ARTIST_SORT_LABELS,UNKNOWN_NONE,UNKNOWN_SOURCE,artistName,assetsFromIds,bucketArtists,isUnknownArtist,sortArtists,unknownArtist,type ArtistBucket,type ArtistSort,type LibraryArtist} from './artistsModel';

const SORT_LABELS = ARTIST_SORT_LABELS;
const SORT_OPTIONS = (Object.entries(SORT_LABELS) as [ArtistSort,string][]).map(([value,label]) => ({value,label}));
const ARTIST_SORT_KEY = 'lakomics.mobile.artistSort';
/** The PC hub's buckets (`ArtistHub.tsx`); pins stay on top of 주요 작가 because the tablet has no sidebar. */
const BUCKET_LABELS: Record<ArtistBucket,string> = {main:'주요 작가',other:'그 외 작가',single:'한 장뿐인 작가',reposter:'퍼온 계정',unknown:'작가 미상'};
const BUCKETS: ArtistBucket[] = ['main','other','single','reposter','unknown'];
const BUCKET_EMPTY: Record<ArtistBucket,string> = {main:'주요 작가가 아직 없습니다',other:'그 외 작가가 없습니다',single:'한 장뿐인 작가가 없습니다',reposter:'퍼온 계정이 없습니다',unknown:'작가 미상인 그림이 없습니다'};
const coversOf = (rows:LibraryArtist[]) => rows.slice(0,12).flatMap(artist=>assetsFromIds(artist.coverAssetIds,artist.coverContentRatings).slice(0,3));

function readSort(): ArtistSort {
  try {
    const value = localStorage.getItem(ARTIST_SORT_KEY);
    if (value === 'recent' || value === 'count' || value === 'name') return value;
  } catch { /* Optional device preference. */ }
  return 'recent';
}

function ArtistGridCard({artist,privateMode,paused,onOpen,onActions}:{artist:LibraryArtist;privateMode:boolean;paused:boolean;onOpen():void;onActions?():void}) {
  const press = useLongPress({enabled: !!onActions, onLongPress: () => onActions?.()});
  const assets = assetsFromIds(artist.coverAssetIds,artist.coverContentRatings).slice(0,3);
  const name = artistName(artist);
  return <button type="button" className="artist-grid-card" {...press.bind} onClick={press.click(onOpen)} aria-label={`${name}, ${artist.assetCount.toLocaleString('ko-KR')}장${artist.pinned ? ', 고정됨' : ''}`}>
    <span className="artist-grid-mosaic">
      <ArtistImage asset={assets[0]} privateMode={privateMode} paused={paused}/>
      <ArtistImage asset={assets[1]} privateMode={privateMode} paused={paused}/>
      <ArtistImage asset={assets[2]} privateMode={privateMode} paused={paused}/>
      {artist.pinned && <span className="artist-grid-pin" aria-label="고정된 작가"><PinSolidIcon aria-hidden="true"/></span>}
    </span>
    <span className="artist-grid-caption"><strong className="artist-grid-name">{name}</strong><span className="artist-grid-count numeric muted">{artist.assetCount.toLocaleString('ko-KR')}</span></span>
  </button>;
}

export function ArtistGrid({artists,state,paused,endpoint,onOpenArtist,onVisibleNames}:{artists:LibraryArtist[];state:'idle'|'loading'|'ready'|'empty';paused:boolean;endpoint:string;onOpenArtist(artist:LibraryArtist):void;onVisibleNames?(names:string[]):void}) {
  const [sheetArtist,setSheetArtist] = useState<LibraryArtist|null>(null);
  const [privateMode] = usePrivacyMode();
  const entry=useArtistEntry(paused,onOpenArtist);
  const [sort,setSort] = useState<ArtistSort>(readSort);
  const [sortOpen,setSortOpen] = useState(false);
  // 작가 미상 counts come with the snapshot the Library root already reads (no second poll here).
  const {unknown} = useLibraryArtists(false,0,endpoint);
  const [view,setView] = useState<{bucket:ArtistBucket;covers:ReadonlyMap<string,string>}>({bucket:'main',covers:new Map()});
  const switching = useRef<AbortController|null>(null);
  useEffect(() => () => switching.current?.abort(), []);
  const unknownRows = useMemo(() => [unknownArtist(UNKNOWN_NONE,unknown.none),unknownArtist(UNKNOWN_SOURCE,unknown.source)].filter(row=>row.assetCount>0),[unknown.none,unknown.source]);
  // Before any artist reaches the tier rule, 주요 작가 lists everyone, as before the buckets.
  const anyMain = artists.some(artist=>artist.main);
  const inBucket = (next:ArtistBucket) => next==='main' && !anyMain ? artists.filter(artist=>!artist.hidden&&!artist.reposter) : bucketArtists(artists,next);
  const counts = useMemo(() => ({main:inBucket('main').length,other:bucketArtists(artists,'other').length,single:bucketArtists(artists,'single').length,reposter:bucketArtists(artists,'reposter').length,unknown:unknown.none+unknown.source}),[artists,anyMain,unknown.none,unknown.source]);
  const bucket = view.bucket;
  const rowsOf = (next:ArtistBucket, nextSort:ArtistSort) => next==='unknown' ? unknownRows : sortArtists(inBucket(next),nextSort);
  const visible = useMemo(() => rowsOf(bucket,sort),[artists,bucket,sort,unknownRows]);
  const showLoading=useDelayedBusy(state==='idle'||state==='loading');
  const host=useRef<HTMLDivElement>(null);
  const firstScreen=useMemo(()=>coversOf(visible),[visible]);
  const initialCovers=usePreparedCovers(firstScreen,!paused&&state==='ready');
  const covers=useMemo(()=>initialCovers&&new Map([...initialCovers,...view.covers]),[initialCovers,view.covers]);
  /** A new bucket stays off screen until its first covers are decoded; the current one stays until then. */
  const show = (next:ArtistBucket) => {
    switching.current?.abort();
    const controller = new AbortController(); switching.current = controller;
    void readyFirstScreen(coversOf(rowsOf(next,sort)),controller.signal,36).then(ready => {
      if (controller.signal.aborted) return;
      switching.current = null;
      setView({bucket:next,covers:new Map(ready.flatMap(asset=>asset.preview?[[asset.id,asset.preview] as const]:[]))});
    });
  };
  // The cards and their thumbnails enter as one: the rise starts once the first screen's covers decode (capped).
  useFirstAppearance(host,visible.length,!paused&&state==='ready',"classification-artists",".artist-grid-card",undefined,ARTIST_LIST_ENTRANCE);
  useEffect(() => { onVisibleNames?.(visible.map(artistName)); }, [onVisibleNames,visible]);

  const chooseSort = (value:ArtistSort) => {
    setSort(value);
    try { localStorage.setItem(ARTIST_SORT_KEY,value); } catch { /* Optional device preference. */ }
    setSortOpen(false);
  };

  return <><div ref={host} className="artist-grid-pane" aria-label="작가 목록" inert={entry.pending} aria-busy={entry.pending}>
    <div className="artist-grid-toolbar">
      {state==='ready' && <div className="artist-bucket-row" role="group" aria-label="작가 나누기">{BUCKETS.filter(value=>value==='main'||value==='other'||counts[value]>0).map(value=>
        <FilterChip key={value} aria-pressed={bucket===value} onClick={() => { if (value!==bucket) show(value); }}>{BUCKET_LABELS[value]} <span className="numeric">{counts[value].toLocaleString('ko-KR')}</span></FilterChip>)}</div>}
      {bucket==='unknown' && <TabletHelp title="작가 미상"><p>작가 정보가 없는 그림을 출처 주소가 없는 것과 출처 주소만 있는 것으로 나눕니다. 장수는 PC가 보낸 집계입니다.</p><p>PC에서 작가에서 제외한 폴더의 그림도 여기에는 함께 보입니다.</p></TabletHelp>}
      {bucket!=='unknown' && <Button size="sm" variant="quiet" className="artist-sort-button" aria-label={`정렬: ${SORT_LABELS[sort]}`} onClick={() => setSortOpen(true)}><ArrowsUpDownIcon aria-hidden="true"/>{SORT_LABELS[sort]}<ChevronDownIcon aria-hidden="true"/></Button>}
    </div>
    {state === 'idle' || state === 'loading' || showLoading || state === 'ready' && !covers ? <div className="artist-empty">{showLoading && <Skeleton className="artist-empty__skeleton" label="작가 목록"/>}</div> : state === 'empty' ? <EmptyArtists/> : visible.length ? <PreparedCovers.Provider value={covers ?? new Map()}><div className="artist-grid-list">{visible.map(artist => <ArtistGridCard key={artist.id} artist={artist} privateMode={privateMode} paused={paused} onOpen={() => void entry.open(artist)} onActions={isUnknownArtist(artist.id) ? undefined : () => setSheetArtist(artist)}/>)}</div></PreparedCovers.Provider> : <EmptyState title={BUCKET_EMPTY[bucket]}/>}
    {sheetArtist && <ArtistActionSheet artist={sheetArtist} endpoint={endpoint} onClose={() => setSheetArtist(null)}/>}
    {sortOpen && <BottomSheet title="정렬" onClose={() => setSortOpen(false)}><SegmentedControl fullWidth label="작가 정렬" options={SORT_OPTIONS} value={sort} onChange={chooseSort}/></BottomSheet>}
  </div>{entry.error&&<div className="inline-error" role="alert">{entry.error}</div>}</>;
}
