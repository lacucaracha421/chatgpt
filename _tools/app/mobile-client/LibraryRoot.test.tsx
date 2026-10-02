import {useState} from 'react';
import {readFileSync} from 'node:fs';
const css=readFileSync('mobile-client/library.css','utf8');
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LibraryRoot} from './LibraryRoot';
import {closeVisibleSearch} from './TopBar';
import {FolderCards} from './FolderCards';
import {mergeLibraryEntries} from './libraryModel';
import type {CharacterIndex} from './characterModel';
import {resetHomeSourceCache} from './homeCache';
import type {LibraryArtist} from './artistsModel';
const mocks=vi.hoisted(()=>({api:vi.fn(async()=>({items:[{id:'cover',kind:'image',preview:'data:image/png;base64,AA'}],has_more:false,next_cursor:null})),native:vi.fn(),thumbnail:vi.fn(async(asset)=>asset)}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:String}));
vi.mock('./media',()=>({loadThumbnail:mocks.thumbnail}));
const characters:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision:'a'.repeat(64),publishedAt:null,nodes:[
 {id:'series:s',kind:'series',sourceId:'s',seriesId:'s',parentId:null,name:'블루 아카이브',description:'',thumbnailAssetId:'series-cover',manualOnly:false,excluded:false},
 {id:'group:g',kind:'group',sourceId:'g',seriesId:'s',parentId:'series:s',name:'학생회',description:'',thumbnailAssetId:'group-cover',manualOnly:false,excluded:false},
 {id:'character:c',kind:'character',sourceId:'c',seriesId:'s',parentId:'group:g',name:'유우카',description:'',thumbnailAssetId:'character-cover',manualOnly:false,excluded:false}
],scopes:[]};
const entries=mergeLibraryEntries([{id:'game',name:'게임',parent_id:null,asset_count:20},{id:'s',name:'블루 아카이브',parent_id:'game',asset_count:10}],characters);
const props={entries,characters,recentFolders:['s'],items:[{id:'all-cover',kind:'image',preview:'data:image/png;base64,AA'}],total:20,paused:false,busy:false,revision:1,onSelect:vi.fn(),onOpenArtist:vi.fn(),onRefresh:vi.fn(),albumTree:null,albumError:'',segment:'folders' as const,onSegment:vi.fn(),restoreScroll:0,onScroll:vi.fn()};
beforeEach(()=>{localStorage.clear();resetHomeSourceCache();vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
it('does not read the similarity queue while the retained root is hidden',async()=>{
 const scope='https://library-root.example';
 const view=render(<LibraryRoot {...props} active={false} similarity={{enabled:true,refreshKey:0,scope,onOpen:vi.fn()}}/>);
 await act(async()=>{await Promise.resolve();});
 expect(mocks.api.mock.calls.some(([path])=>String(path).startsWith('/v1/library/similarity/review'))).toBe(false);
 view.rerender(<LibraryRoot {...props} active similarity={{enabled:true,refreshKey:0,scope,onOpen:vi.fn()}}/>);
 await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/library/similarity/review'))).toHaveLength(1));
});
it('shows root cards and All without recent folders, then searches every character level from the bar',async()=>{
 function Root(){const [segment,onSegment]=useState<'folders'|'albums'|'artists'>('folders');return <LibraryRoot {...props} segment={segment} onSegment={onSegment}/>;}
 render(<Root/>);
 expect(screen.getByRole('heading',{name:'에셋'})).toBeTruthy();
 expect(document.querySelector('.library-recents')).toBeNull();expect(screen.queryByText('최근 연 폴더')).toBeNull();
 // Search is a magnifier in the shared bar until opened.
 expect(screen.queryByRole('searchbox')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/모든 자산/}));expect(props.onSelect).toHaveBeenLastCalledWith({tab:'library',title:'모든 자산'});
 fireEvent.click(screen.getByRole('button',{name:'검색'}));
 const search=screen.getByRole('searchbox',{name:'에셋 찾기'});
 fireEvent.change(search,{target:{value:'학생'}});
 expect(screen.getByRole('region',{name:'캐릭터'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/학생회/}));expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({characterNode:'group:g'}));
 fireEvent.change(search,{target:{value:'유우'}});expect(screen.getByRole('button',{name:/유우카/})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/유우카/}));expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({characterNode:'character:c'}));
 fireEvent.change(search,{target:{value:'없는 폴더'}});await screen.findByText('검색 결과가 없습니다.');
});
it('searches nested albums from the unified field and opens a Library scope',async()=>{
 const tree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[{id:'a',parentId:null,name:'앨범 A',iconKey:null,colorKey:null},{id:'b',parentId:'a',name:'여행',iconKey:null,colorKey:null}]};
 function Root(){const [segment,onSegment]=useState<'folders'|'albums'>('folders');return <LibraryRoot {...props} albumTree={tree} segment={segment} onSegment={onSegment}/>;}
 render(<Root/>);fireEvent.click(screen.getByRole('radio',{name:'앨범'}));
 await screen.findByText('앨범 A');expect(screen.queryByText('여행')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'검색'}));
 fireEvent.change(screen.getByRole('searchbox',{name:'에셋 찾기'}),{target:{value:'여행'}});
 const result=screen.getByRole('button',{name:'여행'});
 expect(result.className).toBe('asset-search-result');
 fireEvent.click(result);expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({album:{id:'b',libraryId:tree.libraryId,epoch:1}}));
 expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.change(screen.getByRole('searchbox',{name:'에셋 찾기'}),{target:{value:'missing'}});
 await screen.findByText('검색 결과가 없습니다.');
});
it('keeps folder thumbnails mounted while switching to albums and back',async()=>{
 const tree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[{id:'a',parentId:null,name:'앨범 A',iconKey:null,colorKey:null}]};
 function Root(){const [segment,onSegment]=useState<'folders'|'albums'>('folders');return <LibraryRoot {...props} albumTree={tree} segment={segment} onSegment={onSegment}/>;}
 render(<Root/>);
 const folderImage=await waitFor(()=>{const image=document.querySelector('.library-root-folders img');if(!image)throw new Error('folder thumbnail not ready');return image;});
 fireEvent.click(screen.getByRole('radio',{name:'앨범'}));await screen.findByText('앨범 A');
 fireEvent.click(screen.getByRole('radio',{name:'분류'}));
 expect(document.querySelector('.library-root-folders img')).toBe(folderImage);
});
const libraryArtist=(id:string,name:string,overrides:Partial<LibraryArtist>={}):LibraryArtist=>({id,label:name,displayName:name,sourceName:name,keys:[`@${id}`],assetCount:10,recentCount:0,firstSavedAt:null,lastSavedAt:null,lastOpenedAt:null,pinned:false,hidden:false,main:false,coverAssetIds:[`${id}-1`,`${id}-2`,`${id}-3`],...overrides});
it('shows the three asset segments and lazily browses pinned artists with search and sort persistence',async()=>{
 const artists=[libraryArtist('pin','지우',{pinned:true,assetCount:2,lastSavedAt:'2026-09-01T00:00:00Z'}),libraryArtist('small','다람',{assetCount:20,lastSavedAt:'2026-09-02T00:00:00Z'}),libraryArtist('large','가나',{assetCount:10,lastSavedAt:'2026-09-03T00:00:00Z'})];
 const original=mocks.api.getMockImplementation()!;
 mocks.api.mockImplementation(async(path:string,signal?:AbortSignal)=>path==='/v1/library/artists'?{artists}:original(path,signal));
 function Root(){const [segment,onSegment]=useState<'folders'|'albums'|'artists'>('folders');return <LibraryRoot {...props} segment={segment} onSegment={onSegment}/>;}
 render(<Root/>);
 expect(screen.getByRole('radiogroup',{name:'에셋 보기'}).closest('.library-root-scroll > .ui-section-bar--inline')).toBeTruthy();
 expect(screen.getAllByRole('radio')).toHaveLength(3);
 fireEvent.click(screen.getByRole('radio',{name:'작가'}));
 await waitFor(()=>expect(mocks.api).toHaveBeenCalledWith('/v1/library/artists',expect.anything()));
 await screen.findByRole('button',{name:/지우, 2장/});
 const cards=[...document.querySelectorAll<HTMLButtonElement>('.artist-grid-card')];
 expect(cards[0].getAttribute('aria-label')).toBe('지우, 2장, 고정됨');
 expect(document.querySelector('.artist-grid-pin')).toBeTruthy();
 fireEvent.click(cards[0]);
 expect(props.onOpenArtist).toHaveBeenCalledWith(artists[0]);
 fireEvent.click(screen.getByRole('button',{name:'검색'}));
 fireEvent.change(screen.getByPlaceholderText('에셋 찾기'),{target:{value:'다람'}});
 expect(screen.getAllByRole('button',{name:/다람/})).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'검색 닫기'}));
 expect(mocks.api.mock.calls.filter(([path])=>path==='/v1/library/artists')).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'정렬: 최근 저장 순'}));
 fireEvent.click(screen.getByRole('radio',{name:'장수'}));
 expect(localStorage.getItem('lakomics.mobile.artistSort')).toBe('count');
 const reordered=[...document.querySelectorAll('.artist-grid-card .artist-grid-name')].map(node=>node.textContent);
 expect(reordered).toEqual(['지우','다람','가나']);
});
it('keeps the root grid and uses the PC style shelf for child folders',()=>{
 const folders=[{id:'a',name:'Parent',parent_id:null,asset_count:1},{id:'b',name:'Plain',parent_id:null,asset_count:0},{id:'c',name:'Child',parent_id:'a',asset_count:1}];
 const view=render(<FolderCards items={folders.slice(0,2)} entries={folders} paused revision={1} onSelect={()=>{}}/>);
 const gridCards=view.container.querySelectorAll('.library-folder');expect(gridCards).toHaveLength(2);
 gridCards.forEach(card=>expect(card.firstElementChild?.classList.contains('home-cover-group')).toBe(true));
 expect(gridCards[0].querySelector('small')).not.toBeNull();expect(gridCards[1].querySelector('small')).toBeNull();
 view.rerender(<FolderCards items={folders.slice(0,2)} entries={folders} paused revision={1} strip onSelect={()=>{}}/>);
 const shelf=view.container.querySelector('.folder-shelf') as HTMLElement;
 expect(shelf).toBeTruthy();
 expect(shelf.querySelector('h3')?.textContent).toBe('폴더 2');
 const shelfCards=shelf.querySelectorAll('.folder-shelf__card-open');expect(shelfCards).toHaveLength(2);
 expect(shelfCards[0].textContent).toContain('Parent');expect(shelfCards[0].textContent).toContain('1장');
 expect(shelfCards[1].textContent).toContain('Plain');expect(shelfCards[1].textContent).toContain('0장');
 expect(css).toMatch(/\.library-folder \{[^}]*display:flex[^}]*flex-direction:column[^}]*justify-content:flex-start/);
 expect(css).toMatch(/\.library-folder \.home-cover-group \{[^}]*width:100%[^}]*flex-shrink:0[^}]*aspect-ratio:4\/3/);
});
it('loads only visible folder covers with two concurrent reads and aborts them when paused',async()=>{
 const observers:{callback:IntersectionObserverCallback;target?:Element}[]=[];
 vi.stubGlobal('IntersectionObserver',class{entry:{callback:IntersectionObserverCallback;target?:Element};constructor(callback:IntersectionObserverCallback){this.entry={callback};observers.push(this.entry);}observe(target:Element){this.entry.target=target;}disconnect(){}});
 const folders=Array.from({length:6},(_,i)=>({id:String(i),name:`폴더 ${i}`,parent_id:null,asset_count:1}));
 const signals:AbortSignal[]=[];const release:(()=>void)[]=[];
 mocks.api.mockImplementation((_path,signal)=>new Promise(resolve=>{signals.push(signal);release.push(()=>resolve({items:[],has_more:false,next_cursor:null}));}));
 const view=render(<FolderCards items={folders} entries={folders} paused={false} revision={1} onSelect={()=>{}}/>);
 expect(mocks.api).not.toHaveBeenCalled();
 act(()=>observers.slice(0,4).forEach(o=>o.callback([{isIntersecting:true,target:o.target}] as IntersectionObserverEntry[],{} as IntersectionObserver)));
 await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(2));
 await act(async()=>release[0]());await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(3));
 expect(mocks.api.mock.calls.every(([path])=>String(path).includes('limit=3'))).toBe(true);
 view.rerender(<FolderCards items={folders} entries={folders} paused revision={1} onSelect={()=>{}}/>);
 expect(signals.every(signal=>signal.aborted)).toBe(true);
});
it('sizes the top-level covers from the real scroller so the first screen ends on a whole row',()=>{
 const folders=Array.from({length:10},(_,i)=>({id:`f${i}`,name:`폴더 ${i}`,parent_id:null,asset_count:i}));
 const rects:Record<string,Partial<DOMRect>>={'library-root-scroll':{top:0,height:1000},'library-folder-grid':{top:200},'library-folder':{height:214},'home-cover-group':{height:180}};
 const rect=vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){const key=Object.keys(rects).find(name=>this.classList.contains(name));return {top:0,left:0,width:0,height:0,...(key?rects[key]:{})} as DOMRect;});
 const height=vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('library-root-scroll')?1000:0;});
 const width=vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('library-folder')?240:0;});
 const computed=window.getComputedStyle;
 vi.spyOn(window,'getComputedStyle').mockImplementation(element=>{const style=computed(element);return element.classList.contains('library-folder-grid')?{...style,gridTemplateColumns:'240px 240px 240px',rowGap:'20px'} as CSSStyleDeclaration:style;});
 render(<LibraryRoot {...props} entries={folders} characters={undefined}/>);
 // 1000 - 200 (above the grid) - 32 (end line) = 768 for three rows, two 20px gaps and 34px captions.
 const root=document.querySelector('.library-root') as HTMLElement;
 expect(root.classList.contains('is-fit')).toBe(true);
 expect(root.style.getPropertyValue('--root-cover-height')).toBe('208px');
 expect(screen.getByText('아래에 분류 1개 더')).toBeTruthy();
 expect(css).toMatch(/\.library-root\.is-fit \.library-root-folders \.library-folder \.home-cover-group \{[^}]*height:var\(--root-cover-height\)/);
 rect.mockRestore();height.mockRestore();width.mockRestore();
});
it('closes the search bar and clears its query on an empty-space tap or Back, but not on a result tap',()=>{
 render(<LibraryRoot {...props}/>);
 const open=(text:string)=>{fireEvent.click(screen.getByRole('button',{name:'검색'}));fireEvent.change(screen.getByRole('searchbox',{name:'에셋 찾기'}),{target:{value:text}});};
 open('학생');
 // Tapping a result is left to the result.
 fireEvent.pointerDown(screen.getByRole('button',{name:/학생회/}));
 expect(screen.getByRole('searchbox',{name:'에셋 찾기'})).toBeTruthy();
 // Empty space outside the bar closes it and drops the query.
 fireEvent.pointerDown(screen.getByLabelText('에셋 검색 제안'));
 expect(screen.queryByRole('searchbox')).toBeNull();expect(document.querySelector('mark')).toBeNull();
 expect(screen.getByRole('heading',{name:'에셋'})).toBeTruthy();
 // Back (App's handler) closes the visible search first, then has nothing more to close.
 open('유우');
 let closed=false;act(()=>{closed=closeVisibleSearch();});expect(closed).toBe(true);
 expect(screen.queryByRole('searchbox')).toBeNull();
 expect(closeVisibleSearch()).toBe(false);
});
it('marks character folders apart from asset folders with a glyph and a card class',()=>{
 const view=render(<FolderCards items={entries} entries={entries} characters={characters} paused revision={1} onSelect={()=>{}}/>);
 const cards=[...view.container.querySelectorAll('.library-folder')];
 const game=cards.find(card=>card.textContent?.includes('게임'))!,series=cards.find(card=>card.textContent?.includes('블루 아카이브'))!;
 expect(game.classList.contains('is-character')).toBe(false);expect(game.querySelector('.character-glyph')).toBeNull();
 expect(series.classList.contains('is-character')).toBe(true);expect(series.querySelector('.character-glyph')).not.toBeNull();
 expect(series.getAttribute('aria-description')).toBe('캐릭터 시리즈');
});

it('animates folder, album and artist cards once each on their first visible segment, without fading images', async () => {
 const animate=vi.fn(()=>({cancel(){}}));
 Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
 const original=mocks.api.getMockImplementation()!;
 mocks.api.mockImplementation(async(path:string,signal?:AbortSignal)=>path==='/v1/library/artists'?{artists:[libraryArtist('appearance','작가',{main:true})]}:original(path,signal));
 const tree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[{id:'album',parentId:null,name:'앨범',iconKey:null,colorKey:null}]};
 try {
  const {MotionScope}=await import('../src/shared/motion/AreaSwitch');
  function Root(){const [segment,onSegment]=useState<'folders'|'albums'|'artists'>('folders');return <MotionScope><LibraryRoot {...props} albumTree={tree} segment={segment} onSegment={onSegment}/></MotionScope>;}
  render(<Root/>);
  const appearances=()=>animate.mock.calls.filter(call=>(call as unknown as [unknown,KeyframeAnimationOptions])[1].duration===560);
  const first=appearances().length;expect(first).toBeGreaterThan(0);
  expect((animate.mock.contexts as HTMLElement[]).every(tile=>tile.matches('.library-folder'))).toBe(true);
  fireEvent.click(screen.getByRole('radio',{name:'앨범'}));
  expect(appearances().length).toBe(first+1);
  fireEvent.click(screen.getByRole('radio',{name:'작가'}));
  await waitFor(()=>expect(appearances().length).toBe(first+2));
  fireEvent.click(screen.getByRole('radio',{name:'분류'}));
  fireEvent.click(screen.getByRole('radio',{name:'앨범'}));
  fireEvent.click(screen.getByRole('radio',{name:'작가'}));
  expect(appearances().length).toBe(first+2);
  expect(appearances().every(call=>JSON.stringify(call[0]).includes('opacity')===false)).toBe(true);
 } finally {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  mocks.api.mockImplementation(original);
 }
});
