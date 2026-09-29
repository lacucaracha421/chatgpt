import {useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode} from 'react';
import {ArrowUpRightIcon, ArrowsUpDownIcon, ChevronDownIcon, ChevronRightIcon, ComputerDesktopIcon, MagnifyingGlassIcon, PhotoIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {EmptyState,IconButton,SectionLabel} from './ui';
import {TopBar, TopBarSearch} from './TopBar';
import {api, native} from './transport';
import {Cover} from './CoverGroup';
import {Gallery} from './Gallery';
import {Scrubber} from './Scrubber';
import {DEFAULT_DENSITY} from './model';
import type {Asset} from './types';
import {usePrivacyMode} from './privacyMode';
import {artistHandles, artistName, assetsFromIds, dateText, daysSince, matchedPositions, matchesArtist, normalizeArtist, normalizeArtists, normalizeAssignments, orderedArtists, profileUrl, todayArtists, type ArtistAssignment, type LibraryArtist} from './artistsModel';
import './artists.css';

type ArtistState = 'loading' | 'ready' | 'empty';
type ArtistPage = {items?: Asset[]; has_more?: boolean; next_cursor?: string | null; list_generation?: string};

export function Placeholder({privateMode = false, label = '이미지 없음'}: {privateMode?: boolean; label?: string}) {
  return <span className={`artist-placeholder${privateMode ? ' is-private' : ''}`} aria-label={privateMode ? '비공개 모드로 이미지 숨김' : label}><PhotoIcon aria-hidden="true" /></span>;
}

export function ArtistImage({asset, privateMode, paused = false}: {asset?: Asset; privateMode: boolean; paused?: boolean}) {
  if (privateMode || !asset) return <Placeholder privateMode={privateMode} />;
  return <span className="artist-image"><Cover asset={asset} paused={paused} /></span>;
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
  const assets = assetsFromIds(artist.coverAssetIds);
  const plus = Math.max(0, artist.assetCount - Math.max(1, Math.min(4, assets.length)));
  const recent = `최근 30일 ${artist.recentCount.toLocaleString('ko-KR')}장 · `;
  return <button className="artist-tile" onClick={onOpen} aria-label={`${artistName(artist)}, ${artist.assetCount.toLocaleString('ko-KR')}장`}>
    <Collage assets={assets} privateMode={privateMode} plus={plus} />
    <span className="artist-tile-info"><strong className="artist-tile-name"><Highlight value={artistName(artist)} query={query} /></strong><span className="artist-tile-count">{artist.assetCount.toLocaleString('ko-KR')}</span><Handles artist={artist} /><small className="artist-tile-recent">{recent}저장 {dateText(artist.lastSavedAt, false) || '—'}</small></span>
  </button>;
}

function SectionHeading({title, meta}: {title: string; meta?: ReactNode}) {
  return <SectionLabel as="h2" className="artist-section-heading" title={title} actions={meta ? <span>{meta}</span> : undefined} />;
}

function ArtistStats({artist, detail = false}: {artist: LibraryArtist; detail?: boolean}) {
  const notSeen = daysSince(artist.lastOpenedAt);
  return <div className={`artist-stats${detail ? ' artist-detail-stats' : ''}`}>
    <span className="artist-stat"><strong>{artist.assetCount.toLocaleString('ko-KR')}<small>장</small></strong>모은 그림</span>
    <span className="artist-stat"><strong>{dateText(artist.firstSavedAt) || '—'}</strong>처음 저장</span>
    <span className="artist-stat"><strong>{dateText(artist.lastSavedAt, false) || '—'}</strong>최근 저장</span>
    {detail && notSeen !== null && <span className="artist-stat"><strong>{notSeen.toLocaleString('ko-KR')}<small>일</small></strong>동안 안 봄</span>}
  </div>;
}

function ArtistToday({artist, privateMode, onOpen}: {artist: LibraryArtist; privateMode: boolean; onOpen(): void}) {
  const assets = assetsFromIds(artist.coverAssetIds);
  const plus = Math.max(0, artist.assetCount - Math.max(1, Math.min(4, assets.length)));
  const notSeen = daysSince(artist.lastOpenedAt);
  return <button className="artist-today" onClick={onOpen} aria-label={`오늘의 작가 ${artistName(artist)}`}>
    <Collage assets={assets} privateMode={privateMode} plus={plus} />
    <span className="artist-today-caption"><span className="artist-reason"><strong>{notSeen !== null ? `${notSeen}일 동안 안 봄` : '오늘의 주요 작가'}</strong>{artist.lastOpenedAt && <> · 마지막으로 연 날 <span className="numeric">{dateText(artist.lastOpenedAt)}</span></>}</span><span className="artist-today-who"><strong>{artistName(artist)}</strong><Handles artist={artist} /></span><ArtistStats artist={artist} /></span>
  </button>;
}

function ArtistHub({artists, assignments, query, privateMode, paused, onOpen}: {artists: LibraryArtist[]; assignments: ArtistAssignment[]; query: string; privateMode: boolean; paused:boolean; onOpen(artist: LibraryArtist): void}) {
  const scroller=useRef<HTMLDivElement>(null);
  const major = useMemo(() => artists.some(artist => artist.main) ? artists.filter(artist => artist.main) : artists, [artists]);
  const visible = useMemo(() => query.trim() ? artists.filter(artist => matchesArtist(artist, query)) : orderedArtists(major), [artists, major, query]);
  const picks = todayArtists(artists);
  const main = picks[0];
  const others = picks.slice(1, 3);
  const assignmentCount = new Map<string, number>();
  assignments.forEach(row => assignmentCount.set(row.artistId, (assignmentCount.get(row.artistId) ?? 0) + 1));
  const scrubberSort=useMemo(()=>({kind:'fallback' as const}),[]);
  return <div ref={scroller} className="artist-scroll" aria-label="작가 목록">
    {query.trim() ? <div className="artist-search-hint"><strong>결과 {visible.length.toLocaleString('ko-KR')}명</strong><span>이름 · 핸들 · 초성으로 찾기</span></div> : <div className="artist-content">
      {main && <section className="artist-section" aria-label="오늘"><SectionHeading title="오늘" meta={`${new Date().getMonth() + 1}월 ${new Date().getDate()}일 · ${picks.length}명`} /><ArtistToday artist={main} privateMode={privateMode} onOpen={() => onOpen(main)} /><div className="artist-other-picks">{others.map(artist => <button key={artist.id} className="artist-other-pick" onClick={() => onOpen(artist)} aria-label={`${artistName(artist)} 작가`}><Collage assets={assetsFromIds(artist.coverAssetIds)} privateMode={privateMode} /><span className="artist-pick-text"><strong>{artistName(artist)}</strong><small>{artist.lastOpenedAt ? `${daysSince(artist.lastOpenedAt) ?? 0}일 동안 안 봄` : artist.recentCount ? `최근 30일 ${artist.recentCount}장` : '주요 작가'}</small></span><ChevronRightIcon aria-hidden="true" /></button>)}</div></section>}
    </div>}
    <section className={`artist-section${query.trim() ? '' : ' artist-content'}`} aria-label="주요 작가"><div className="artist-sort-line"><SectionHeading title={query.trim() ? '검색 결과' : '최근 저장 순'} meta={query.trim() ? undefined : <>주요 작가 · {major.length}명</>} /><span>{assignments.length ? `${assignmentCount.size}명 게시` : ''}</span></div><div className="artist-grid">{visible.map(artist => <ArtistTile key={artist.id} artist={artist} privateMode={privateMode} query={query} onOpen={() => onOpen(artist)} />)}</div>{visible.length === 0 && <EmptyState icon={PhotoIcon} title="검색 결과가 없습니다" />}</section>
    <Scrubber scrollRef={scroller} total={visible.length} sort={scrubberSort} hidden={paused}/>
  </div>;
}

export function EmptyArtists() { return <EmptyState icon={PhotoIcon} title="PC 앱이 작가 목록을 아직 보내지 않았습니다" />; }

function assetPage(value: unknown): ArtistPage {
  if (!value || typeof value !== 'object') return {};
  const page = value as ArtistPage;
  return {items: Array.isArray(page.items) ? page.items.filter(item => !!item && typeof item.id === 'string') : [], has_more: page.has_more === true, next_cursor: typeof page.next_cursor === 'string' ? page.next_cursor : null, list_generation: page.list_generation};
}

function ArtistIntro({artist, privateMode, sort, filter, onSort, onFilter, assets}: {artist: LibraryArtist; privateMode: boolean; sort: 'newest' | 'oldest'; filter: 'all' | 'image' | 'video'; onSort(): void; onFilter(value: 'all' | 'image' | 'video'): void; assets: Asset[]}) {
  const avatar = assetsFromIds(artist.coverAssetIds)[0];
  const imageCount = assets.filter(asset => asset.kind !== 'video').length || Math.max(0, artist.assetCount - assets.filter(asset => asset.kind === 'video').length);
  const videoCount = assets.filter(asset => asset.kind === 'video').length;
  return <div className="artist-detail-intro">
    <div className="artist-detail-identity"><span className="artist-avatar"><ArtistImage asset={avatar} privateMode={privateMode} /></span><span className="artist-detail-identity-text"><h2>{artistName(artist)}</h2><Handles artist={artist} /></span></div>
    <ArtistStats artist={artist} detail />
    <div className="artist-pc-note"><ComputerDesktopIcon aria-hidden="true" />이름 바꾸기 · 다른 작가와 합치기 · 숨기기는 PC 앱에서</div>
    <div className="artist-filter-row"><button className="artist-filter" aria-pressed={sort === 'newest'} onClick={onSort}><ArrowsUpDownIcon aria-hidden="true" />{sort === 'newest' ? '최근 저장 순' : '처음 저장 순'}<ChevronDownIcon aria-hidden="true" /></button><button className="artist-filter" aria-pressed={filter === 'image'} onClick={() => onFilter(filter === 'image' ? 'all' : 'image')}>이미지 {imageCount.toLocaleString('ko-KR')}</button><button className="artist-filter" aria-pressed={filter === 'video'} onClick={() => onFilter(filter === 'video' ? 'all' : 'video')}>영상 {videoCount.toLocaleString('ko-KR')}</button></div>
  </div>;
}

function ArtistDetail({summary, assignments, privateMode, paused, onBack, onOpenViewer}: {summary: LibraryArtist; assignments: ArtistAssignment[]; privateMode: boolean; paused:boolean; onBack(): void; onOpenViewer(items: Asset[], index: number): void}) {
  const [artist, setArtist] = useState(summary);
  const [missing, setMissing] = useState(false);
  const [assets, setAssets] = useState<Asset[]>(() => assetsFromIds(assignments.filter(row => row.artistId === summary.id).map(row => row.assetId)));
  const [source, setSource] = useState<'assigned' | 'covers' | 'gallery'>(() => assets.length ? 'assigned' : 'covers');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [filter, setFilter] = useState<'all' | 'image' | 'video'>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const fallback = assetsFromIds(summary.coverAssetIds);
  const primaryKey = summary.keys[0];
  useEffect(() => {
    const controller = new AbortController();
    void api<{artist?: LibraryArtist}>(`/v1/library/artists/${encodeURIComponent(summary.id)}`, controller.signal).then(reply => {
      const next = normalizeArtist(reply.artist);
      if (!controller.signal.aborted && next) setArtist(next);
    }, reason => { if (!controller.signal.aborted && (reason as {status?: number})?.status === 404) setMissing(true); });
    return () => controller.abort();
  }, [summary.id]);
  useEffect(() => {
    if (privateMode || !primaryKey) return;
    const controller = new AbortController();
    void api<ArtistPage>(`/v1/library/revisit/creator/${encodeURIComponent(primaryKey)}/assets?limit=100&sort=${sort}`, controller.signal).then(value => {
      const page = assetPage(value);
      if (!controller.signal.aborted && page.items?.length) { setAssets(page.items); setSource('gallery'); setCursor(page.next_cursor ?? null); }
    }, () => {});
    return () => controller.abort();
  }, [primaryKey, privateMode, sort]);
  const filtered = useMemo(() => {
    const next = filter === 'all' ? assets : assets.filter(asset => filter === 'video' ? asset.kind === 'video' : asset.kind !== 'video');
    return sort === 'oldest' && source !== 'gallery' ? [...next].reverse() : next;
  }, [assets, filter, sort, source]);
  const profile = profileUrl(artist);
  const loadMore = () => {
    if (privateMode || !primaryKey || !cursor || loadingMore) return;
    setLoadingMore(true);
    const controller = new AbortController();
    void api<ArtistPage>(`/v1/library/revisit/creator/${encodeURIComponent(primaryKey)}/assets?limit=100&cursor=${encodeURIComponent(cursor)}&sort=${sort}`, controller.signal).then(value => {
      const page = assetPage(value);
      if (page.items?.length) { setAssets(current => [...current, ...page.items!.filter(item => !current.some(old => old.id === item.id))]); setCursor(page.next_cursor ?? null); }
    }, () => {}).finally(() => setLoadingMore(false));
  };
  if (missing) return <div className="artist-screen"><TopBar back={{label:'작가 목록으로', onClick:onBack}} crumbs={<span className="top-bar__crumbs">홈 › 작가 ›</span>} title={artistName(summary)} /><EmptyArtists /></div>;
  const shown = filtered.length ? filtered : fallback;
  return <div className="artist-screen"><TopBar back={{label:'작가 목록으로', onClick:onBack}} crumbs={<span className="top-bar__crumbs">홈 › 작가 ›</span>} title={artistName(artist)} actions={profile ? <IconButton label="작가 프로필 열기" icon={ArrowUpRightIcon} onClick={() => { void native('openExternal', {url: profile}).catch(() => {}); }} /> : undefined} />
    <div className="artist-detail-scroll"><Gallery items={shown} density={DEFAULT_DENSITY} identity={`artist:${artist.id}:${sort}:${filter}:${source}`} restoreScroll={0} onScroll={() => {}} onReady={ready => setAssets(current => current.map(asset => asset.id === ready.id ? {...asset, ...ready} : asset))} onNearEnd={loadMore} paused={privateMode||paused} privacy={privateMode} intro={<ArtistIntro artist={artist} privateMode={privateMode} sort={sort} filter={filter} onSort={() => setSort(value => value === 'newest' ? 'oldest' : 'newest')} onFilter={setFilter} assets={shown} />} onOpen={index => { if (!privateMode) onOpenViewer(shown, index); }} />{!shown.length && <div className="artist-detail-empty">PC가 이 작가의 asset id를 아직 게시하지 않았습니다.</div>}</div>
  </div>;
}

export function Artists({endpoint, backRef, onOpenViewer, paused=false, initialArtist, onClose}: {endpoint: string; backRef: MutableRefObject<(() => boolean) | null>; onOpenViewer(items: Asset[], index: number): void; paused?:boolean; initialArtist?: LibraryArtist; onClose?(): void}) {
  const [privateMode] = usePrivacyMode();
  const [state, setState] = useState<ArtistState>('loading');
  const [artists, setArtists] = useState<LibraryArtist[]>([]);
  const [assignments, setAssignments] = useState<ArtistAssignment[]>([]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [detail, setDetail] = useState<LibraryArtist | null>(() => initialArtist ?? null);
  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void api<unknown>('/v1/library/artists', controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const next = normalizeArtists(value);
      setArtists(next); setAssignments(normalizeAssignments(value)); setState(next.length ? 'ready' : 'empty');
    }, () => { if (!controller.signal.aborted) setState('empty'); });
    return () => controller.abort();
  }, [endpoint]);
  useEffect(() => {
    backRef.current = () => {
      if (detail) { if (initialArtist && onClose) onClose(); else setDetail(null); return true; }
      if (searchOpen) { setSearchOpen(false); setQuery(''); return true; }
      return false;
    };
    return () => { backRef.current = null; };
  }, [backRef, detail, initialArtist, onClose, searchOpen]);
  const closeSearch = () => { setSearchOpen(false); setQuery(''); };
  if (detail) return <ArtistDetail summary={detail} assignments={assignments} privateMode={privateMode} paused={paused} onBack={() => { if (initialArtist && onClose) onClose(); else setDetail(null); }} onOpenViewer={onOpenViewer} />;
  const header = searchOpen ? <TopBarSearch title="작가" onClose={closeSearch}><label className="top-bar__search"><MagnifyingGlassIcon aria-hidden="true" /><input autoFocus type="search" aria-label="작가 검색" placeholder="이름, 핸들, 초성" value={query} onChange={event => setQuery(event.target.value)} />{query && <IconButton label="검색어 지우기" icon={XMarkIcon} onClick={() => setQuery('')} />}</label></TopBarSearch> : <TopBar back={{label:'홈으로', onClick:() => window.dispatchEvent(new Event('lakomics-back'))}} crumbs={<span className="top-bar__crumbs">홈 ›</span>} title="작가" count={artists.length ? artists.length.toLocaleString('ko-KR') : undefined} actions={state === 'ready' ? <IconButton label="작가 검색" icon={MagnifyingGlassIcon} onClick={() => setSearchOpen(true)} /> : undefined} />;
  return <div className="artist-screen">{header}{state === 'loading' ? <div className="artist-empty" role="status"><span>작가 목록을 불러오는 중입니다</span></div> : state === 'empty' ? <EmptyArtists /> : <ArtistHub artists={artists} assignments={assignments} query={query} privateMode={privateMode} paused={paused} onOpen={setDetail} />}</div>;
}
