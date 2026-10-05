import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MutableRefObject} from 'react';
import {Artists} from './Artists';
import {LibraryRoot} from './LibraryRoot';
import {AssetScopeChips} from './AssetScopeChips';
import {matchesArtist, matchedPositions, type LibraryArtist} from './artistsModel';
import type {SparseGallerySource} from './assetToc';
import {commitArtistEdit, readArtistEdits} from './artistEditOutbox';

const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn(), loadThumbnail: vi.fn()}));
vi.mock('./transport', () => ({api: mocks.api, native: mocks.native, errorText:(e:Error)=>e.message}));
vi.mock('./media', () => ({loadThumbnail: mocks.loadThumbnail}));
vi.mock('./Gallery', () => ({Gallery: ({intro, items, onOpen, onNearEnd, sparse, stale, onRefresh, likesRevision}: {intro?: React.ReactNode; items: {id: string}[]; onOpen(index: number): void; onNearEnd():void; sparse?:SparseGallerySource; stale?:boolean;onRefresh?():void;likesRevision?:unknown}) => <div aria-label="자산 목록" data-likes-revision={String(likesRevision)} data-toc={sparse?.toc.totalCount} data-stale={stale}>{intro}<button onClick={onRefresh}>refresh gallery</button>{items.map((item, index) => <button key={item.id} onClick={() => onOpen(index)}>asset-{item.id}</button>)}<button onClick={onNearEnd}>more</button>{sparse&&<button onClick={()=>void sparse.load(2,1,new AbortController().signal)}>seek</button>}</div>}));

const artist = (id: string, label: string, overrides: Partial<LibraryArtist> = {}): LibraryArtist => ({
  id, label, displayName: label, sourceName: label, keys: [`@${id}`], assetCount: 74, recentCount: 2,
  firstSavedAt: '2025-03-02T00:00:00Z', lastSavedAt: '2026-09-22T00:00:00Z', lastOpenedAt: '2026-01-19T00:00:00Z',
  pinned: false, hidden: false, main: false, coverAssetIds: [`${id}-1`, `${id}-2`, `${id}-3`, `${id}-4`, `${id}-5`], ...overrides,
});
const primary = artist('haneul', '하늘빛', {main: true});
const other = artist('honoka', '호노카', {assetCount: 66, keys: ['@honoka_p'], coverAssetIds: ['honoka-1', 'honoka-2']});
const cat = artist('hannat', '한낮고양이', {assetCount: 29, recentCount: 0, keys: ['@hannat_cat']});
const reply = {version: 1, revision: 4, publishedAt: '2026-09-27T00:00:00Z', generatedAt: '2026-09-27T00:00:00Z', settings: {mainMinCount: 5, recentMinCount: 2, recentDays: 30}, unknown: {none: 0, source: 0}, artists: [primary, other, cat], assignments: [{assetId: 'haneul-1', artistId: 'haneul', source: 'source_url' as const}]};
const detail = {...primary};
let backRef: MutableRefObject<(() => boolean) | null>;

function renderArtists() {
  backRef = {current: null};
  return render(<Artists endpoint="https://example.invalid" backRef={backRef} onOpenViewer={vi.fn()} />);
}

beforeEach(() => {
  localStorage.clear(); mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/v1/library/artists') return reply;
    if (path.startsWith('/v1/library/artists/')) return {version: 1, revision: 4, artist: detail, assignedAssetCount: 1};
    if (path.startsWith('/v1/library/assets?')) return {items: [{id: 'haneul-1', kind: 'image', width: 600, height: 800}], has_more: false, next_cursor: null, filterVersion:1};
    throw new Error(`unexpected path ${path}`);
  });
  mocks.native.mockResolvedValue({});
  mocks.loadThumbnail.mockImplementation(async (asset: {id: string}) => ({...asset, preview: `blob:${asset.id}`}));
});
afterEach(() => {cleanup(); vi.restoreAllMocks();});

describe('artist model', () => {
  it('starts the today picks and the artist list as one held entrance, and none under reduced motion', async () => {
    const plays = vi.fn();
    const animate = vi.fn(() => ({cancel: vi.fn(), pause: vi.fn(), play: plays}));
    Object.defineProperty(HTMLElement.prototype, 'animate', {configurable: true, value: animate});
    vi.stubGlobal('CSS', {supports: () => false});
    try {
      const view = renderArtists();
      await screen.findByRole('button', {name: '오늘의 작가 하늘빛'});
      const parts = () => animate.mock.calls.filter((_call, i) => (animate.mock.contexts[i] as unknown as HTMLElement).matches('.artist-today, .artist-other-pick, .artist-tile'));
      await waitFor(() => expect(plays).toHaveBeenCalledTimes(parts().length));
      expect(parts().length).toBeGreaterThan(1);
      expect(parts().every(call => (call as unknown as Keyframe[][])[0][0].visibility === 'hidden')).toBe(true);
      view.unmount(); animate.mockClear();
      vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
      renderArtists();
      await screen.findByRole('button', {name: '오늘의 작가 하늘빛'});
      expect(parts()).toHaveLength(0);
    } finally {delete (HTMLElement.prototype as Partial<HTMLElement>).animate; vi.unstubAllGlobals();}
  });

  it('matches Korean initials and underlines the matched syllables', () => {
    expect(matchesArtist(primary, 'ㅎㄴ')).toBe(true);
    expect(matchedPositions('하늘빛', 'ㅎㄴ')).toEqual(new Set([0, 1]));
  });
});

describe('Artists', () => {
  it('opens the shared hidden artist sheet from the actual Library root list', async () => {
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, ...args: unknown[]) => {
      if (path === '/v1/library/artists') return Promise.resolve({...reply, artists: [{...primary, hidden: true}, other]});
      if (path.endsWith('/intents')) return Promise.reject(new Error('offline'));
      return original(path, ...args);
    });
    render(<LibraryRoot endpoint="https://example.invalid" entries={[]} items={[]} paused={false} busy={false} revision={0}
      onSelect={vi.fn()} onOpenArtist={vi.fn()} onRefresh={vi.fn()} albumTree={null} albumError=""
      segment="artists" onSegment={vi.fn()} restoreScroll={0} onScroll={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', {name: '숨긴 작가 · 1명'}));
    fireEvent.click(screen.getByRole('button', {name: '하늘빛 숨김 해제'}));
    expect(await screen.findByText('숨긴 작가가 없습니다.')).toBeTruthy();
    expect(readArtistEdits('https://example.invalid')[0].action).toBe('unhide');
  });
  it('renames offline through the shared sheet and retains the edit on remount', async () => {
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, ...args: unknown[]) => path.endsWith('/intents')
      ? Promise.reject(new Error('offline')) : original(path, ...args));
    const view = renderArtists();
    await screen.findByRole('button', {name: /하늘빛, 74장/});
    fireEvent.click(screen.getByRole('button', {name: /하늘빛, 74장/}));
    fireEvent.click(await screen.findByRole('button', {name: '작가 더보기'}));
    fireEvent.click(screen.getByRole('button', {name: '이름 바꾸기'}));
    fireEvent.change(screen.getByRole('textbox', {name: '작가 이름'}), {target: {value: '새 이름'}});
    fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await screen.findByRole('heading', {level: 2, name: '새 이름'});
    await waitFor(() => expect(mocks.api.mock.calls.some(call => call[0].endsWith('/intents'))).toBe(true));
    expect(readArtistEdits('https://example.invalid')[0]).toMatchObject({artistId: 'haneul', action: 'rename', displayName: '새 이름'});
    view.unmount();
    renderArtists();
    expect(await screen.findByRole('button', {name: /새 이름, 74장/})).toBeTruthy();
  });

  it('hides an artist from the hub and restores it through the hidden artist sheet', async () => {
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, ...args: unknown[]) => path.endsWith('/intents')
      ? Promise.reject(new Error('offline')) : original(path, ...args));
    renderArtists();
    fireEvent.click(await screen.findByRole('button', {name: /하늘빛, 74장/}));
    fireEvent.click(await screen.findByRole('button', {name: '작가 더보기'}));
    fireEvent.click(screen.getByRole('button', {name: '숨기기'}));
    act(() => backRef.current?.());
    expect(screen.queryByRole('button', {name: /하늘빛, 74장/})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: '숨긴 작가 · 1명'}));
    fireEvent.click(screen.getByRole('button', {name: '하늘빛 숨김 해제'}));
    expect(await screen.findByText('숨긴 작가가 없습니다.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '닫기'}));
    expect(screen.getByRole('button', {name: /하늘빛, 74장/})).toBeTruthy();
    expect(readArtistEdits('https://example.invalid').map(row => row.action)).toEqual(['hide', 'unhide']);
  });

  it('toggles pinned state and keeps merge as a PC-only note', async () => {
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, ...args: unknown[]) => path.endsWith('/intents')
      ? Promise.reject(new Error('offline')) : original(path, ...args));
    renderArtists();
    fireEvent.click(await screen.findByRole('button', {name: /하늘빛, 74장/}));
    fireEvent.click(await screen.findByRole('button', {name: '작가 더보기'}));
    fireEvent.click(screen.getByRole('button', {name: '고정'}));
    fireEvent.click(await screen.findByRole('button', {name: '작가 더보기'}));
    expect(screen.getByRole('button', {name: '고정 해제'})).toBeTruthy();
    expect(screen.queryByRole('button', {name: /합치기/})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: '고정 해제'}));
    expect(readArtistEdits('https://example.invalid').map(row => row.action)).toEqual(['pin', 'unpin']);
  });

  it('keeps content during refresh and resolves the open bare key to the new artist id', async () => {
    let refresh!: (value: unknown) => void;
    let refreshing = false;
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, ...args: unknown[]) => refreshing && path === '/v1/library/artists'
      ? new Promise(resolve => { refresh = resolve; }) : original(path, ...args));
    renderArtists();
    fireEvent.click(await screen.findByRole('button', {name: /하늘빛, 74장/}));
    await screen.findByText('asset-haneul-1');
    refreshing = true;
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(refresh).toBeDefined());
    expect(screen.getByRole('heading', {level: 2, name: '하늘빛'})).toBeTruthy();
    expect(screen.getByText('asset-haneul-1')).toBeTruthy();
    await act(async () => refresh({...reply, revision: 5, artists: [{...primary, id: 'artist:uuid', label: '새 이름', displayName: '새 이름'}, other, cat]}));
    await screen.findByRole('heading', {level: 2, name: '새 이름'});
    expect(mocks.api.mock.calls.some(([path]) => path.includes('artist=artist%3Auuid'))).toBe(true);
  });

  it('does not flash the old name between POST acceptance and the next GET', async () => {
    let refresh!: (value: unknown) => void;
    let posted = false;
    let operationId = '';
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, signal: AbortSignal, body?: {operationId: string}) => {
      if (path.endsWith('/intents')) {
        posted = true; operationId = body!.operationId;
        return Promise.resolve({version: 1, operationId, sequence: 1, revision: 5});
      }
      if (path === '/v1/library/artists' && posted) return new Promise(resolve => { refresh = resolve; });
      return original(path, signal);
    });
    renderArtists();
    fireEvent.click(await screen.findByRole('button', {name: /하늘빛, 74장/}));
    act(() => { commitArtistEdit('https://example.invalid', primary, 'rename', '새 이름'); });
    await waitFor(() => expect(refresh).toBeDefined());
    expect(screen.getByRole('heading', {level: 2, name: '새 이름'})).toBeTruthy();
    expect(readArtistEdits('https://example.invalid')).toHaveLength(1);
    await act(async () => refresh({...reply, revision: 5, artists: [{...primary, label: '새 이름', displayName: '새 이름'}],
      pending: [{operationId, sequence: 1, artistId: primary.id, action: 'rename', displayName: '새 이름'}]}));
    expect(screen.getByRole('heading', {level: 2, name: '새 이름'})).toBeTruthy();
    expect(readArtistEdits('https://example.invalid')).toHaveLength(0);
  });

  it('holds the open detail when the bare id returns 404 before the refreshed list resolves it', async () => {
    let finishList!: (value: unknown) => void;
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, ...args: unknown[]) => {
      if (path === '/v1/library/artists') return new Promise(resolve => { finishList = resolve; });
      if (path === `/v1/library/artists/${primary.id}`) return Promise.reject({status: 404});
      return original(path, ...args);
    });
    render(<Artists endpoint="test" backRef={{current: null}} initialArtist={primary} onOpenViewer={vi.fn()} />);
    await screen.findByText('asset-haneul-1');
    expect(screen.queryByText('PC 앱이 작가 목록을 아직 보내지 않았습니다')).toBeNull();
    await act(async () => finishList({...reply, artists: [{...primary, id: 'artist:uuid'}]}));
    expect(screen.getByRole('heading', {level: 2, name: '하늘빛'})).toBeTruthy();
    expect(screen.queryByText('PC 앱이 작가 목록을 아직 보내지 않았습니다')).toBeNull();
    expect(mocks.api.mock.calls.some(([path]) => path.includes('artist=artist%3Auuid'))).toBe(true);
  });

  it('uses the published artist id and TOC seek, including artists without creator keys', async () => {
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>{
      if(!path.startsWith('/v1/library/assets?'))return original(path);
      const params=new URL(path,'https://test').searchParams;
      expect(params.get('artist')).toBe(primary.id);
      expect(params.get('sort')).toBe('newest');
      if(params.has('toc'))return Promise.resolve({tocVersion:1,listGeneration:'g1',totalCount:3,sort:'newest',buckets:[{key:'2026-10',count:2,startIndex:0,startCursor:null},{key:'2025-01',count:1,startIndex:2,startCursor:'old-month'}]});
      return Promise.resolve({items:[{id:params.has('cursor')?'manual':'merged-key',kind:'image'}],has_more:!params.has('cursor'),next_cursor:params.has('cursor')?null:'next',listGeneration:'g1'});
    });
    render(<Artists endpoint="test" backRef={{current:null}} initialArtist={{...primary,keys:[]}} onOpenViewer={vi.fn()}/>);
    await screen.findByText('asset-merged-key');
    expect(screen.getByLabelText('자산 목록').getAttribute('data-toc')).toBe('3');
    fireEvent.click(screen.getByText('seek'));
    await screen.findByText('asset-manual');
    const tocPath=mocks.api.mock.calls.find(([path])=>path.includes('toc=1'))![0];
    expect(new URL(tocPath,'https://test').searchParams.has('utcOffsetMinutes')).toBe(true);
    expect(mocks.api.mock.calls.some(([path])=>path.includes('cursor=old-month'))).toBe(true);
    expect(mocks.api.mock.calls.some(([path])=>path.includes('/revisit/'))).toBe(false);
  });

  it('ignores a next page that completes after the sort changes', async () => {
    let resolveMore!:(value:unknown)=>void;
    let moreSignal!:AbortSignal;
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string,signal:AbortSignal)=>{
      if(!path.startsWith('/v1/library/assets?'))return original(path);
      const params=new URL(path,'https://test').searchParams;
      if(params.has('toc'))return Promise.reject(new Error('old server'));
      if(params.has('cursor')){moreSignal=signal;return new Promise(resolve=>{resolveMore=resolve;});}
      return Promise.resolve({items:[{id:params.get('sort')==='oldest'?'old-first':'new-first',kind:'image'}],has_more:true,next_cursor:'next'});
    });
    render(<Artists endpoint="test" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()}/>);
    await screen.findByText('asset-new-first');
    fireEvent.click(screen.getByText('more'));
    fireEvent.click(screen.getByRole('button',{name:'최근 저장 순'}));
    await screen.findByText('asset-old-first');
    expect(moreSignal.aborted).toBe(true);
    await act(async()=>resolveMore({items:[{id:'stale-new-page',kind:'image'}],has_more:false,next_cursor:null}));
    expect(screen.queryByText('asset-stale-new-page')).toBeNull();
    expect(screen.queryByText('asset-new-first')).toBeNull();
  });

  it('keeps the viewport during a TOC seek and ignores its late result after a sort change', async () => {
    let finishSeek!:(value:unknown)=>void;
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>{
      if(!path.startsWith('/v1/library/assets?'))return original(path);
      const params=new URL(path,'https://test').searchParams,sort=params.get('sort');
      if(params.has('toc'))return Promise.resolve({tocVersion:1,listGeneration:sort,totalCount:3,sort,buckets:[{key:'2026-10',count:2,startIndex:0,startCursor:null},{key:'2025-01',count:1,startIndex:2,startCursor:'bucket'}]});
      if(params.has('cursor'))return new Promise(resolve=>{finishSeek=resolve;});
      return Promise.resolve({items:[{id:`${sort}-first`,kind:'image'}],has_more:true,next_cursor:'next',listGeneration:sort});
    });
    render(<Artists endpoint="test" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()}/>);
    await screen.findByText('asset-newest-first');
    fireEvent.click(screen.getByText('seek'));
    await waitFor(()=>expect(finishSeek).toBeDefined());
    expect(screen.getByText('asset-newest-first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'최근 저장 순'}));
    await screen.findByText('asset-oldest-first');
    await act(async()=>finishSeek({items:[{id:'stale-destination',kind:'image'}],has_more:false,next_cursor:null,listGeneration:'newest'}));
    expect(screen.queryByText('asset-stale-destination')).toBeNull();
  });

  it('refreshes a TOC seek when its page belongs to another generation', async () => {
    let changed=false;
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>{
      if(!path.startsWith('/v1/library/assets?'))return original(path);
      const params=new URL(path,'https://test').searchParams;
      if(params.has('cursor'))changed=true;
      const generation=changed?'g2':'g1';
      if(params.has('toc'))return Promise.resolve({tocVersion:1,listGeneration:generation,totalCount:3,sort:'newest',buckets:[{key:'2026-10',count:2,startIndex:0,startCursor:null},{key:'2025-01',count:1,startIndex:2,startCursor:'bucket'}]});
      return Promise.resolve({items:[{id:params.has('cursor')?'wrong-generation':changed?'refreshed':'first',kind:'image'}],has_more:true,next_cursor:'next',listGeneration:generation});
    });
    render(<Artists endpoint="test" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()}/>);
    await screen.findByText('asset-first');
    fireEvent.click(screen.getByText('seek'));
    await screen.findByText('asset-refreshed');
    expect(screen.queryByText('asset-wrong-generation')).toBeNull();
    expect(screen.getByLabelText('자산 목록').getAttribute('data-toc')).toBe('3');
  });

  it('shows an empty video result without image covers and sends the filter to both reads', async () => {
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>path.includes('media_kind=videos')?Promise.resolve({items:[],has_more:false,next_cursor:null,filterVersion:1}):original(path));
    render(<Artists endpoint="test" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()}/>);
    await screen.findByText('asset-haneul-1');
    fireEvent.click(screen.getByRole('button',{name:/영상 0/}));
    await screen.findByText('조건에 맞는 자산이 없습니다.');
    expect(screen.queryByText('asset-haneul-1')).toBeNull();
    expect(mocks.api.mock.calls.filter(([path])=>path.includes('media_kind=videos'))).toHaveLength(2);
  });

  it('does not fabricate a cover-only page when direct entry is offline, and can retry', async () => {
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/library/assets?')?Promise.reject(new Error('offline')):original(path));
    render(<Artists endpoint="test" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()}/>);
    await screen.findByRole('alert');
    expect(screen.queryByText('asset-haneul-1')).toBeNull();
    expect(screen.queryByLabelText('자산 목록')).toBeNull();
    mocks.api.mockImplementation(original);
    fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
    await screen.findByText('asset-haneul-1');
  });

  it('does not read artwork pages or TOCs in private mode', async () => {
    localStorage.setItem('lakomics.mobile.privacyMode','1');
    render(<Artists endpoint="test" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()}/>);
    await screen.findByRole('heading',{level:2,name:'하늘빛'});
    expect(mocks.api.mock.calls.some(([path])=>path.startsWith('/v1/library/assets?'))).toBe(false);
    expect(mocks.loadThumbnail).not.toHaveBeenCalled();
  });
  it('starts on an initial artist detail and closes through the owner on Back', async () => {
    const close = vi.fn();
    const directRef: MutableRefObject<(() => boolean) | null> = {current: null};
    render(<Artists endpoint="https://example.invalid" backRef={directRef} initialArtist={primary} onClose={close} onOpenViewer={vi.fn()} />);
    expect(await screen.findByRole('heading', {level: 2, name: '하늘빛'})).toBeTruthy();
    act(() => { expect(directRef.current?.()).toBe(true); });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('retains the removable search scope when the chosen artist has disappeared', async () => {
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>path===`/v1/library/artists/${primary.id}`?Promise.reject({status:404}):path==='/v1/library/artists'?Promise.resolve({...reply,artists:[other,cat]}):original(path));
    const remove=vi.fn();
    render(<Artists endpoint="https://example.invalid" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()} scopeChips={<AssetScopeChips chips={[{kind:'artist',id:primary.id,name:'하늘빛'}]} onRemove={remove}/>}/>);
    await screen.findByText('PC 앱이 작가 목록을 아직 보내지 않았습니다');
    fireEvent.click(screen.getByRole('button',{name:'하늘빛 범위 제거'}));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('renders a fixture list with today picks and major artist tiles', async () => {
    renderArtists();
    expect(await screen.findByRole('region', {name: '오늘'})).toBeTruthy();
    expect(screen.getByRole('button', {name: /하늘빛, 74장/})).toBeTruthy();
    expect(screen.getByText('주요 작가 · 1명')).toBeTruthy();
  });

  it('uses the calm unpublished state for an empty or 404 publication', async () => {
    mocks.api.mockRejectedValueOnce({status: 404});
    renderArtists();
    expect(await screen.findByText('PC 앱이 작가 목록을 아직 보내지 않았습니다')).toBeTruthy();
  });

  it('searches by choseong and underlines matching name syllables', async () => {
    renderArtists();
    await screen.findByRole('region', {name: '오늘'});
    fireEvent.click(screen.getByRole('button', {name: '작가 검색'}));
    fireEvent.change(screen.getByRole('searchbox', {name: '작가 검색'}), {target: {value: 'ㅎㄴ'}});
    await waitFor(() => expect(screen.getByRole('button', {name: /하늘빛, 74장/})).toBeTruthy());
    expect(document.querySelectorAll('mark').length).toBeGreaterThanOrEqual(2);
  });

  it('opens detail and consumes Back before leaving the artist hub', async () => {
    renderArtists();
    await screen.findByRole('region', {name: '오늘'});
    fireEvent.click(screen.getByRole('button', {name: /하늘빛, 74장/}));
    expect(await screen.findByRole('heading', {level: 2, name: '하늘빛'})).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith('/v1/library/artists/haneul', expect.anything());
    act(() => { expect(backRef.current?.()).toBe(true); });
    expect(await screen.findByRole('region', {name: '오늘'})).toBeTruthy();
  });

  it('keeps all artist artwork as neutral placeholders in privacy mode', async () => {
    localStorage.setItem('lakomics.mobile.privacyMode', '1');
    renderArtists();
    await screen.findByRole('region', {name: '오늘'});
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getAllByLabelText('비공개 모드로 이미지 숨김').length).toBeGreaterThan(0);
  });
});
