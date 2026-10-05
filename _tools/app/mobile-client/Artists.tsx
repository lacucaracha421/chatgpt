import { useDelayedBusy } from "../src/shared/useDelayedBusy";
import {useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode} from 'react';
import {ArrowTopRightOnSquareIcon, ArrowsUpDownIcon, ChevronDownIcon, ChevronRightIcon, ComputerDesktopIcon, EllipsisHorizontalIcon, MagnifyingGlassIcon, PhotoIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Button, EmptyState, Field, IconButton, SectionLabel, Skeleton, TextInput} from './ui';
import {BottomSheet} from './BottomSheet';
import {useLibraryArtists} from './useLibraryArtists';
import {commitArtistEdit, resolveArtist, type ArtistEditAction} from './artistEditOutbox';
import {TopBar, TopBarSearch} from './TopBar';
import {api, errorText, native} from './transport';
import {Cover} from './CoverGroup';
import {Gallery} from './Gallery';
import {Scrubber} from './Scrubber';
import {DEFAULT_DENSITY, normalizePage} from './model';
import {filterVersionOf, ASSET_FILTER_VERSION} from './assetFilters';
import {readScopedToc, readyScopedAsset, useScopedAssetToc, withScopedToc} from './scopedAssetToc';
import {preparedArtistPage, prepareArtistPage, useArtistEntry, type ArtistPage} from './ArtistGridEntry';
import type {Asset, PageWire} from './types';
import {usePrivacyMode} from './privacyMode';
import {artistHandles, artistName, assetsFromIds, daysSince, matchedPositions, matchesArtist, orderedArtists, profileUrl, todayArtists, type ArtistAssignment, type LibraryArtist} from './artistsModel';
import {displayDate} from '../src/shared/displayDate';
import {useFirstAppearance} from '../src/shared/motion/useFirstAppearance';
import {ARTIST_LIST_ENTRANCE, PreparedCovers, usePreparedCovers} from './artistCovers';
import './artists.css';

type EditArtist = (artist: LibraryArtist, action: ArtistEditAction, displayName?: string | null) => void;

/** Used by both the retained Library root and the standalone artist hub. */
export function HiddenArtists({endpoint, artists, onOpen, pending = 0, syncError = '', onRetry}: {endpoint: string; artists: LibraryArtist[]; onOpen(artist: LibraryArtist): void; pending?: number; syncError?: string; onRetry?(): void}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const hidden = artists.filter(artist => artist.hidden);
  return <>
    <div className="artist-hidden-entry"><Button variant="quiet" onClick={() => { setError(''); setOpen(true); }}>숨긴 작가 · {hidden.length}명</Button></div>
    {open && <BottomSheet title="숨긴 작가" onClose={() => setOpen(false)}>
      {pending > 0 && <p className="hint" role="status">작가 변경 전송 대기 중 · {pending}건</p>}
      {!hidden.length && <p className="hint">숨긴 작가가 없습니다.</p>}
      {hidden.map(artist => <div className="artist-hidden-row" key={artist.id}>
        <Button variant="quiet" onClick={() => { setOpen(false); onOpen(artist); }}>{artistName(artist)}</Button>
        <Button variant="quiet" aria-label={`${artistName(artist)} 숨김 해제`} onClick={() => {
          try { commitArtistEdit(endpoint, artist, 'unhide'); setError(''); }
          catch (reason) { setError(errorText(reason)); }
        }}>숨김 해제</Button>
      </div>)}
      {error && <p className="error-message" role="alert">{error}</p>}
      {syncError && <div className="inline-error" role="alert">{syncError}{onRetry && <Button variant="quiet" onClick={onRetry}>다시 시도</Button>}</div>}
    </BottomSheet>}
  </>;
}

function ArtistEditMenu({artist, onEdit}: {artist: LibraryArtist; onEdit: EditArtist}) {
  const [sheet, setSheet] = useState<'menu' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const save = (action: ArtistEditAction, displayName?: string | null) => {
    try { onEdit(artist, action, displayName); setSheet(null); setError(''); }
    catch (reason) { setError(errorText(reason)); }
  };
  return <>
    <IconButton label="작가 더보기" icon={EllipsisHorizontalIcon} onClick={() => { setError(''); setSheet('menu'); }} />
    {sheet && <BottomSheet title={sheet === 'rename' ? '이름 바꾸기' : artistName(artist)} onClose={() => setSheet(null)}>
      {sheet === 'menu' ? <>
        <Button variant="quiet" onClick={() => { setName(artist.displayName ?? ''); setSheet('rename'); }}>이름 바꾸기</Button>
        <Button variant="quiet" onClick={() => save(artist.hidden ? 'unhide' : 'hide')}>{artist.hidden ? '숨김 해제' : '숨기기'}</Button>
        <Button variant="quiet" onClick={() => save(artist.pinned ? 'unpin' : 'pin')}>{artist.pinned ? '고정 해제' : '고정'}</Button>
        <p className="hint">합치기는 PC 앱에서</p>
      </> : <form className="artist-rename" onSubmit={event => { event.preventDefault(); save('rename', name); }}>
        <Field label="작가 이름"><TextInput autoFocus value={name} placeholder={artist.sourceName ?? artist.label}
          onChange={event => setName(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
          }} /></Field>
        <p className="hint">비워 두면 원래 이름을 사용합니다. 최대 120자</p>
        <Button type="submit">저장</Button>
      </form>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </BottomSheet>}
  </>;
}

export function Placeholder({privateMode = false, label = '이미지 없음'}: {privateMode?: boolean; label?: string}) {
  return <span className={`artist-placeholder${privateMode ? ' is-private' : ''}`} aria-label={privateMode ? '비공개 모드로 이미지 숨김' : label}><PhotoIcon aria-hidden="true" /></span>;
}

export function ArtistImage({asset, privateMode, paused = false}: {asset?: Asset; privateMode: boolean; paused?: boolean}) {
  const prepared = useContext(PreparedCovers);
  if (privateMode || !asset) return <Placeholder privateMode={privateMode} />;
  return <span className="artist-image"><Cover asset={asset} paused={paused} ready={prepared.get(asset.id)} /></span>;
}

function Collage({assets, privateMode, plus}: {assets: Asset[]; privateMode: boolean; plus?: number}) {
  const cells = [assets[0], assets[1], assets[2], assets[3], assets[4]];
  return <span className="artist-collage">
    <ArtistImage asset={cells[0]} privateMode={privateMode} />
    <ArtistImage asset={cells[1]} privateMode={privateMode} />
    <ArtistImage asset={cells[2]} privateMode={privateMode} />
    <ArtistImage asset={cells[3]} privateMode={privateMode} />
    <span className="artist-plus"><ArtistImage asset={cells[4]} privateMode={privateMode} />{plus !== undefined && plus > 0 && <span>+{plus.toLocaleString('ko-KR')}</span>}</span>
  </span>;
}

function Highlight({value, query}: {value: string; query: string}) {
  if (!query.trim()) return <>{value}</>;
  const positions = matchedPositions(value, query);
  return <>{Array.from(value).map((character, index) => positions.has(index) ? <mark key={index}>{character}</mark> : <span key={index}>{character}</span>)}</>;
}

function Handles({artist}: {artist: LibraryArtist}) {
  const handles = artistHandles(artist);
  return <span className="artist-handle">{handles.length ? handles.join(' · ') : artist.sourceName || '핸들 없음'}</span>;
}

function ArtistTile({artist, privateMode, query, onOpen}: {artist: LibraryArtist; privateMode: boolean; query: string; onOpen(): void}) {
  const assets = assetsFromIds(artist.coverAssetIds,artist.coverContentRatings);
  const plus = Math.max(0, artist.assetCount - Math.max(1, Math.min(4, assets.length)));
  const recent = `최근 30일 ${artist.recentCount.toLocaleString('ko-KR')}장 · `;
  return <button className="artist-tile" onClick={onOpen} aria-label={`${artistName(artist)}, ${artist.assetCount.toLocaleString('ko-KR')}장`}>
    <Collage assets={assets} privateMode={privateMode} plus={plus} />
    <span className="artist-tile-info"><strong className="artist-tile-name"><Highlight value={artistName(artist)} query={query} /></strong><span className="artist-tile-count">{artist.assetCount.toLocaleString('ko-KR')}</span><Handles artist={artist} /><small className="artist-tile-recent">{recent}저장 {displayDate(artist.lastSavedAt) || '—'}</small></span>
  </button>;
}

function SectionHeading({title, meta}: {title: string; meta?: ReactNode}) {
  return <SectionLabel as="h2" className="artist-section-heading" title={title} actions={meta ? <span>{meta}</span> : undefined} />;
}

function ArtistStats({artist, detail = false}: {artist: LibraryArtist; detail?: boolean}) {
  const notSeen = daysSince(artist.lastOpenedAt);
  return <div className={`artist-stats${detail ? ' artist-detail-stats' : ''}`}>
    <span className="artist-stat"><strong>{artist.assetCount.toLocaleString('ko-KR')}<small>장</small></strong>모은 그림</span>
    <span className="artist-stat"><strong>{displayDate(artist.firstSavedAt) || '—'}</strong>처음 저장</span>
    <span className="artist-stat"><strong>{displayDate(artist.lastSavedAt) || '—'}</strong>최근 저장</span>
    {detail && notSeen !== null && <span className="artist-stat"><strong>{notSeen.toLocaleString('ko-KR')}<small>일</small></strong>동안 안 봄</span>}
  </div>;
}

function ArtistToday({artist, privateMode, onOpen}: {artist: LibraryArtist; privateMode: boolean; onOpen(): void}) {
  const assets = assetsFromIds(artist.coverAssetIds,artist.coverContentRatings);
  const plus = Math.max(0, artist.assetCount - Math.max(1, Math.min(4, assets.length)));
  const notSeen = daysSince(artist.lastOpenedAt);
  return <button className="artist-today" onClick={onOpen} aria-label={`오늘의 작가 ${artistName(artist)}`}>
    <Collage assets={assets} privateMode={privateMode} plus={plus} />
    <span className="artist-today-caption"><span className="artist-reason"><strong>{notSeen !== null ? `${notSeen}일 동안 안 봄` : '오늘의 주요 작가'}</strong>{artist.lastOpenedAt && <> · 마지막으로 연 날 <span className="numeric">{displayDate(artist.lastOpenedAt)}</span></>}</span><span className="artist-today-who"><strong>{artistName(artist)}</strong><Handles artist={artist} /></span><ArtistStats artist={artist} /></span>
  </button>;
}

function ArtistHub({artists, assignments, query, privateMode, paused, onOpen}: {artists: LibraryArtist[]; assignments: ArtistAssignment[]; query: string; privateMode: boolean; paused:boolean; onOpen(artist: LibraryArtist): void}) {
  const scroller=useRef<HTMLDivElement>(null);
  const major = useMemo(() => artists.some(artist => artist.main || artist.pinned) ? artists.filter(artist => artist.main || artist.pinned) : artists, [artists]);
  const visible = useMemo(() => query.trim() ? artists.filter(artist => matchesArtist(artist, query)) : orderedArtists(major), [artists, major, query]);
  const picks = todayArtists(artists);
  const main = picks[0];
  const others = picks.slice(1, 3);
  const assignmentCount = new Map<string, number>();
  assignments.forEach(row => assignmentCount.set(row.artistId, (assignmentCount.get(row.artistId) ?? 0) + 1));
  const scrubberSort=useMemo(()=>({kind:'fallback' as const}),[]);
  const firstScreen=useMemo(()=>[main,...others,...visible.slice(0,6)].flatMap(artist=>artist?assetsFromIds(artist.coverAssetIds,artist.coverContentRatings).slice(0,5):[]),[main,others,visible]);
  const covers=usePreparedCovers(firstScreen,!paused);
  // Today's picks and the artist list rise together with their prepared covers.
  useFirstAppearance(scroller,covers?visible.length+picks.length:0,!paused&&!query.trim(),'artist-hub','.artist-today, .artist-other-pick, .artist-tile',undefined,ARTIST_LIST_ENTRANCE);
  if(!covers)return <div ref={scroller} className="artist-scroll" aria-label="작가 목록" aria-busy="true"/>;
  return <PreparedCovers.Provider value={covers}><div ref={scroller} className="artist-scroll" aria-label="작가 목록">
    {query.trim() ? <div className="artist-search-hint"><strong>결과 {visible.length.toLocaleString('ko-KR')}명</strong><span>이름 · 핸들 · 초성으로 찾기</span></div> : <div className="artist-content">
      {main && <section className="artist-section" aria-label="오늘"><SectionHeading title="오늘" meta={`${displayDate(new Date())} · ${picks.length}명`} /><ArtistToday artist={main} privateMode={privateMode} onOpen={() => onOpen(main)} /><div className="artist-other-picks">{others.map(artist => <button key={artist.id} className="artist-other-pick" onClick={() => onOpen(artist)} aria-label={`${artistName(artist)} 작가`}><Collage assets={assetsFromIds(artist.coverAssetIds,artist.coverContentRatings)} privateMode={privateMode} /><span className="artist-pick-text"><strong>{artistName(artist)}</strong><small>{artist.lastOpenedAt ? `${daysSince(artist.lastOpenedAt) ?? 0}일 동안 안 봄` : artist.recentCount ? `최근 30일 ${artist.recentCount}장` : '주요 작가'}</small></span><ChevronRightIcon aria-hidden="true" /></button>)}</div></section>}
    </div>}
    <section className={`artist-section${query.trim() ? '' : ' artist-content'}`} aria-label="주요 작가"><div className="artist-sort-line"><SectionHeading title={query.trim() ? '검색 결과' : '최근 저장 순'} meta={query.trim() ? undefined : <>주요 작가 · {major.length}명</>} /><span>{assignments.length ? `${assignmentCount.size}명 게시` : ''}</span></div><div className="artist-grid">{visible.map(artist => <ArtistTile key={artist.id} artist={artist} privateMode={privateMode} query={query} onOpen={() => onOpen(artist)} />)}</div>{visible.length === 0 && <EmptyState icon={PhotoIcon} title="검색 결과 없음" />}</section>
    <Scrubber scrollRef={scroller} total={visible.length} sort={scrubberSort} hidden={paused}/>
  </div></PreparedCovers.Provider>;
}

export function EmptyArtists() { return <EmptyState icon={PhotoIcon} title="PC 앱이 작가 목록을 아직 보내지 않았습니다" />; }

function ArtistIntro({artist, privateMode, sort, filter, onSort, onFilter, assets}: {artist: LibraryArtist; privateMode: boolean; sort: 'newest' | 'oldest'; filter: 'all' | 'image' | 'video'; onSort(): void; onFilter(value: 'all' | 'image' | 'video'): void; assets: Asset[]}) {
  const avatar = assetsFromIds(artist.coverAssetIds,artist.coverContentRatings)[0];
  const imageCount = assets.filter(asset => asset.kind !== 'video').length || Math.max(0, artist.assetCount - assets.filter(asset => asset.kind === 'video').length);
  const videoCount = assets.filter(asset => asset.kind === 'video').length;
  return <div className="artist-detail-intro">
    <div className="artist-detail-identity"><span className="artist-avatar"><ArtistImage asset={avatar} privateMode={privateMode} /></span><span className="artist-detail-identity-text"><h2>{artistName(artist)}</h2><Handles artist={artist} /></span></div>
    <ArtistStats artist={artist} detail />
    <div className="artist-pc-note"><ComputerDesktopIcon aria-hidden="true" />합치기는 PC 앱에서</div>
    <div className="artist-filter-row"><button className="artist-filter" aria-pressed={sort === 'newest'} onClick={onSort}><ArrowsUpDownIcon aria-hidden="true" />{sort === 'newest' ? '최근 저장 순' : '처음 저장 순'}<ChevronDownIcon aria-hidden="true" /></button><button className="artist-filter" aria-pressed={filter === 'image'} onClick={() => onFilter(filter === 'image' ? 'all' : 'image')}>이미지 {imageCount.toLocaleString('ko-KR')}</button><button className="artist-filter" aria-pressed={filter === 'video'} onClick={() => onFilter(filter === 'video' ? 'all' : 'video')}>영상 {videoCount.toLocaleString('ko-KR')}</button></div>
  </div>;
}

function ArtistDetail({scopeChips,summary, initialPage, assignments, privateMode, paused, onBack, onOpenViewer, onEdit, notice, listed}: {scopeChips?:ReactNode;summary: LibraryArtist; initialPage?:ArtistPage; assignments: ArtistAssignment[]; privateMode: boolean; paused:boolean; onBack(): void; onOpenViewer(items: Asset[], index: number): void; onEdit: EditArtist; notice: ReactNode; listed: boolean | undefined}) {
  const artist = summary;
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState<ArtistPage|undefined>(initialPage);
  const seeded=useRef(initialPage);
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [filter, setFilter] = useState<'all' | 'image' | 'video'>('all');
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const generation = useRef(0), moreRequest = useRef<AbortController|null>(null);
  const scope = `${summary.id}:${sort}:${filter}`;
  const latest = useRef({scope, privateMode});latest.current={scope,privateMode};
  const assigned = assetsFromIds(assignments.filter(row => row.artistId === summary.id).map(row => row.assetId));
  const fallback = assigned.length ? assigned : assetsFromIds(summary.coverAssetIds);
  const path = (cursor:string|null, toc=false) => {
    const params=new URLSearchParams({artist:summary.id,sort,limit:'100'});
    if(filter!=='all')params.set('media_kind',filter==='video'?'videos':'images');
    if(cursor)params.set('cursor',cursor);
    if(toc){params.delete('limit');params.set('toc','1');params.set('utcOffsetMinutes',String(-new Date().getTimezoneOffset()));}
    return `/v1/library/assets?${params}`;
  };
  const read = async(cursor:string|null, signal:AbortSignal):Promise<ArtistPage> => {
    const raw=await api<PageWire&{listGeneration?:string}>(path(cursor),signal);
    if(filter!=='all'&&filterVersionOf(raw)!==ASSET_FILTER_VERSION)throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
    return {...normalizePage(raw),list_generation:raw.listGeneration,scope};
  };
  useEffect(() => {
    const controller = new AbortController();
    setMissing(false);
    void api<{artist?: LibraryArtist}>(`/v1/library/artists/${encodeURIComponent(summary.id)}`, controller.signal).then(reply => {
      // The list owns editable fields, including queued changes. A late detail read
      // must never overwrite them with the previous server state.
      if (!controller.signal.aborted && reply.artist) setMissing(false);
    }, reason => { if (!controller.signal.aborted && (reason as {status?: number})?.status === 404) setMissing(true); });
    return () => controller.abort();
  }, [summary.id]);
  useEffect(() => {
    const version=++generation.current;
    moreRequest.current?.abort();moreRequest.current=null;setLoadingMore(false);
    if(seeded.current?.scope===scope){seeded.current=undefined;return;}
    seeded.current=undefined;
    if(privateMode){setBusy(false);return;}
    const controller=new AbortController();setBusy(true);setError('');
    void withScopedToc(read(null,controller.signal).then(result=>prepareArtistPage(result,controller.signal)),readScopedToc(path(null,true),controller.signal),sort).then(result=>{
      if(!controller.signal.aborted&&generation.current===version)setPage(result);
    },reason=>{if(!controller.signal.aborted&&generation.current===version)setError(errorText(reason));})
      .finally(()=>{if(generation.current===version)setBusy(false);});
    return()=>{controller.abort();moreRequest.current?.abort();generation.current++;};
  }, [summary.id, privateMode, sort, filter, retry]);
  const changeSort = () => {generation.current++;moreRequest.current?.abort();setSort(value=>value==='newest'?'oldest':'newest');};
  const changeFilter = (value:'all'|'image'|'video') => {generation.current++;moreRequest.current?.abort();setFilter(value);};
  const sparse=useScopedAssetToc(page,setPage,!privateMode&&!paused&&!busy&&page?.scope===scope,read,()=>setRetry(value=>value+1),setError);
  const profile = profileUrl(artist);
  const loadMore = () => {
    if(privateMode||paused||busy||page?.assetRanges||page?.scope!==scope||!page.next_cursor||moreRequest.current)return;
    const version=generation.current,controller=new AbortController();moreRequest.current=controller;setLoadingMore(true);
    void read(page.next_cursor,controller.signal).then(result=>{
      if(controller.signal.aborted||generation.current!==version||latest.current.scope!==scope||latest.current.privateMode)return;
      if(page.list_generation&&page.list_generation!==result.list_generation){setRetry(value=>value+1);return;}
      setPage(current=>current?.scope===scope?{...result,items:[...current.items,...result.items.filter(item=>!current.items.some(old=>old.id===item.id))]}:current);
    },reason=>{if(!controller.signal.aborted&&generation.current===version)setError(errorText(reason));})
      .finally(()=>{if(moreRequest.current===controller){moreRequest.current=null;setLoadingMore(false);}});
  };
  if (missing && listed === false) return <div className="artist-screen"><TopBar back={{label:'작가 목록으로', onClick:onBack}} crumbs={<span className="top-bar__crumbs">홈 › 작가 ›</span>} title={artistName(summary)} />{scopeChips}{notice}<EmptyArtists /></div>;
  // Direct entries without a prepared list handoff have no detail content to retain. Never
  // present the artist's cover IDs as a page: they have neither dates nor gallery dimensions.
  if(!page&&!privateMode)return <div className="artist-screen"><TopBar back={{label:'작가 목록으로',onClick:onBack}} title={artistName(artist)}/>{notice}<div className="artist-empty" role="status" aria-busy={!error}/>{error&&<div className="inline-error" role="alert">{error}<button onClick={()=>setRetry(value=>value+1)}>다시 시도</button></div>}</div>;
  const local = filter==='all'?fallback:fallback.filter(asset=>filter==='video'?asset.kind==='video':asset.kind!=='video');
  const shown = page?.items ?? (sort==='oldest'?[...local].reverse():local);
  const stale = !!page && page.scope!==scope;
  return <div className="artist-screen"><TopBar back={{label:'작가 목록으로', onClick:onBack}} crumbs={<span className="top-bar__crumbs">홈 › 작가 ›</span>} title={artistName(artist)} actions={<>{profile && <IconButton label="작가 프로필 열기" icon={ArrowTopRightOnSquareIcon} onClick={() => { void native('openExternal', {url: profile}).catch(() => {}); }} />}<ArtistEditMenu artist={artist} onEdit={onEdit} /></>} />{notice}
    <div className="artist-detail-scroll"><Gallery sparse={privateMode?undefined:sparse} items={shown} privacy={privateMode} stale={stale} busy={busy||loadingMore} onRefresh={()=>setRetry(value=>value+1)} density={DEFAULT_DENSITY} identity={`artist:${page?.scope??scope}`} restoreScroll={0} onScroll={() => {}} onReady={ready => setPage(current=>current?readyScopedAsset(current,ready):current)} onNearEnd={loadMore} paused={privateMode||paused} intro={<>{scopeChips}<ArtistIntro artist={artist} privateMode={privateMode} sort={sort} filter={filter} onSort={changeSort} onFilter={changeFilter} assets={shown} /></>} onOpen={index => { if (!privateMode&&!stale) onOpenViewer(shown, index); }} />{!shown.length&&!busy && <div className="artist-detail-empty">조건에 맞는 자산이 없습니다.</div>}{error&&<div className="inline-error" role="alert">{error}<button onClick={()=>setRetry(value=>value+1)}>다시 시도</button></div>}</div>
  </div>;
}

export function Artists({scopeChips,endpoint, backRef, onOpenViewer, paused=false, initialArtist, onClose}: {scopeChips?:ReactNode;endpoint: string; backRef: MutableRefObject<(() => boolean) | null>; onOpenViewer(items: Asset[], index: number): void; paused?:boolean; initialArtist?: LibraryArtist; onClose?(): void}) {
  const [privateMode] = usePrivacyMode();
  const {state, artists, allArtists, assignments, pending, error, retry, loaded} = useLibraryArtists(!paused, 0, endpoint);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selection, setSelection] = useState<{endpoint: string; artist: LibraryArtist | null}>(() => ({endpoint, artist: initialArtist ?? null}));
  const detail = selection.endpoint === endpoint ? selection.artist : null;
  const setDetail = (artist: LibraryArtist | null) => setSelection({endpoint, artist});
  const entry=useArtistEntry(paused,setDetail);
  useEffect(()=>entry.cancel(),[endpoint]);
  useEffect(() => {
    backRef.current = () => {
      if(entry.pending){entry.cancel();return true;}
      if (detail) { if (initialArtist && onClose) onClose(); else setDetail(null); return true; }
      if (searchOpen) { setSearchOpen(false); setQuery(''); return true; }
      return false;
    };
    return () => { backRef.current = null; };
  }, [backRef, detail, initialArtist, onClose, searchOpen, entry.pending]);
  const closeSearch = () => { setSearchOpen(false); setQuery(''); };
  const onEdit: EditArtist = (artist, action, displayName) => { commitArtistEdit(endpoint, artist, action, displayName); };
  const notice = <>{pending > 0 && <p className="artist-edit-status" role="status">작가 변경 전송 대기 중 · {pending}건</p>}{error && <div className="inline-error" role="alert">{error}<Button variant="quiet" onClick={retry}>다시 시도</Button></div>}</>;
  const resolved = detail ? resolveArtist(allArtists, detail) : undefined;
  const showLoading=useDelayedBusy(!allArtists.length&&(state==='loading'||state==='idle'));
  if (detail) return <ArtistDetail scopeChips={scopeChips} summary={resolved ?? detail} initialPage={preparedArtistPage(detail)} listed={loaded ? !!resolved : undefined} assignments={assignments} privateMode={privateMode} paused={paused} notice={notice} onEdit={onEdit} onBack={() => { if (initialArtist && onClose) onClose(); else setDetail(null); }} onOpenViewer={onOpenViewer} />;
  const header = searchOpen ? <TopBarSearch title="작가" onClose={closeSearch}><label className="top-bar__search"><MagnifyingGlassIcon aria-hidden="true" /><input autoFocus type="search" aria-label="작가 검색" placeholder="이름, 핸들, 초성" value={query} onChange={event => setQuery(event.target.value)} />{query && <IconButton label="검색어 지우기" icon={XMarkIcon} onClick={() => setQuery('')} />}</label></TopBarSearch> : <TopBar back={{label:'홈으로', onClick:() => window.dispatchEvent(new Event('lakomics-back'))}} crumbs={<span className="top-bar__crumbs">홈 ›</span>} title="작가" count={artists.length ? artists.length.toLocaleString('ko-KR') : undefined} actions={state === 'ready' ? <IconButton label="작가 검색" icon={MagnifyingGlassIcon} onClick={() => setSearchOpen(true)} /> : undefined} />;
  return <><div className="artist-screen" inert={entry.pending} aria-busy={entry.pending}>{header}{notice}
    <HiddenArtists endpoint={endpoint} artists={allArtists} onOpen={artist=>void entry.open(artist)} pending={pending} syncError={error} onRetry={retry} />
    {showLoading || (!allArtists.length && (state === 'loading' || state === 'idle')) ? <div className="artist-empty">{showLoading&&<Skeleton className="artist-empty__skeleton" label="작가 목록"/>}</div> : !allArtists.length ? <EmptyArtists /> : <ArtistHub artists={artists} assignments={assignments} query={query} privateMode={privateMode} paused={paused} onOpen={artist=>void entry.open(artist)} />}
  </div>{entry.error&&<div className="inline-error" role="alert">{entry.error}</div>}</>;
}
