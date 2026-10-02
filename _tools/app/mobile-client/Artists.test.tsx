import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MutableRefObject} from 'react';
import {Artists} from './Artists';
import {AssetScopeChips} from './AssetScopeChips';
import {matchesArtist, matchedPositions, type LibraryArtist} from './artistsModel';
import type {SparseGallerySource} from './assetToc';

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
  it('matches Korean initials and underlines the matched syllables', () => {
    expect(matchesArtist(primary, 'ㅎㄴ')).toBe(true);
    expect(matchedPositions('하늘빛', 'ㅎㄴ')).toEqual(new Set([0, 1]));
  });
});

describe('Artists', () => {
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

  it('keeps local artwork offline but an offline video scope has no image fallback', async () => {
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/library/assets?')?Promise.reject(new Error('offline')):original(path));
    render(<Artists endpoint="test" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()}/>);
    await screen.findByRole('alert');
    expect(screen.getByText('asset-haneul-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:/영상 0/}));
    await screen.findByText('조건에 맞는 자산이 없습니다.');
    expect(screen.queryByText('asset-haneul-1')).toBeNull();
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
    mocks.api.mockImplementation((path:string)=>path===`/v1/library/artists/${primary.id}`?Promise.reject({status:404}):original(path));
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

it('refreshes artist hearts without resetting the gallery scroll identity',async()=>{
  render(<Artists endpoint="test" backRef={{current:null}} initialArtist={primary} onOpenViewer={vi.fn()}/>);
  await screen.findByText('asset-haneul-1');
  const before=screen.getByLabelText('자산 목록').getAttribute('data-likes-revision');
  fireEvent.click(screen.getByText('refresh gallery'));
  await waitFor(()=>expect(screen.getByLabelText('자산 목록').getAttribute('data-likes-revision')).not.toBe(before));
});
