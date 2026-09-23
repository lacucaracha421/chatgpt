import {useState} from 'react';
import {readFileSync} from 'node:fs';
const css=readFileSync('mobile-client/library.css','utf8');
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LibraryRoot} from './LibraryRoot';
import {FolderCards} from './FolderCards';
import {mergeLibraryEntries} from './libraryModel';
import type {CharacterIndex} from './characterModel';
const mocks=vi.hoisted(()=>({api:vi.fn(async()=>({items:[{id:'cover',kind:'image',preview:'data:image/png;base64,AA'}],has_more:false,next_cursor:null})),native:vi.fn(),thumbnail:vi.fn(async(asset)=>asset)}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:String}));
vi.mock('./media',()=>({loadThumbnail:mocks.thumbnail}));
const characters:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision:'a'.repeat(64),publishedAt:null,nodes:[
 {id:'series:s',kind:'series',sourceId:'s',seriesId:'s',parentId:null,name:'블루 아카이브',description:'',thumbnailAssetId:'series-cover',manualOnly:false,excluded:false},
 {id:'group:g',kind:'group',sourceId:'g',seriesId:'s',parentId:'series:s',name:'학생회',description:'',thumbnailAssetId:'group-cover',manualOnly:false,excluded:false},
 {id:'character:c',kind:'character',sourceId:'c',seriesId:'s',parentId:'group:g',name:'유우카',description:'',thumbnailAssetId:'character-cover',manualOnly:false,excluded:false}
],scopes:[]};
const entries=mergeLibraryEntries([{id:'game',name:'게임',parent_id:null,asset_count:20},{id:'s',name:'블루 아카이브',parent_id:'game',asset_count:10}],characters);
const props={entries,characters,recentFolders:['s'],items:[{id:'all-cover',kind:'image',preview:'data:image/png;base64,AA'}],total:20,paused:false,busy:false,revision:1,onSelect:vi.fn(),onRefresh:vi.fn(),albumTree:null,albumError:'',segment:'folders' as const,onSegment:vi.fn(),restoreScroll:0,onScroll:vi.fn()};
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
it('shows root cards, text-only recent chips and All, then searches every character level with highlights',async()=>{
 render(<LibraryRoot {...props}/>);
 expect(screen.getByRole('heading',{name:'라이브러리'})).toBeTruthy();
 const recents=document.querySelector('.library-recents')!;
 expect(recents.textContent).toBe('블루 아카이브');expect(recents.querySelector('img,svg,small,.home-cover')).toBeNull();
 expect(css).toMatch(/\.library-recents button[^}]*min-height:44px/);
 expect(css).toMatch(/\.library-recents \{[^}]*flex-wrap:nowrap[^}]*overflow-x:auto/);
 expect(screen.getByText('하위 폴더 1')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/모든 자산/}));expect(props.onSelect).toHaveBeenLastCalledWith({tab:'library',title:'모든 자산'});
 fireEvent.click(screen.getByRole('button',{name:'블루 아카이브'}));expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({characterNode:'series:s'}));
 const search=screen.getByRole('searchbox',{name:'폴더·캐릭터 찾기'});
 fireEvent.change(search,{target:{value:'학생'}});
 expect(document.querySelector('mark')?.textContent).toBe('학생');
 expect(screen.getByText('캐릭터 그룹 · 게임 › 블루 아카이브')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/학생회/}));expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({characterNode:'group:g'}));
 fireEvent.change(search,{target:{value:'유우'}});expect(screen.getByText('캐릭터 · 게임 › 블루 아카이브 › 학생회')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/유우카/}));expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({characterNode:'character:c'}));
 fireEvent.change(search,{target:{value:'없는 폴더'}});expect(screen.getByText('일치하는 폴더가 없습니다.')).toBeTruthy();
});
it('searches nested albums as folder-style result rows and opens a Library scope',async()=>{
 const tree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[{id:'a',parentId:null,name:'앨범 A',iconKey:null,colorKey:null},{id:'b',parentId:'a',name:'여행',iconKey:null,colorKey:null}]};
 function Root(){const [segment,onSegment]=useState<'folders'|'albums'>('folders');return <LibraryRoot {...props} albumTree={tree} segment={segment} onSegment={onSegment}/>;}
 render(<Root/>);fireEvent.click(screen.getByRole('tab',{name:'앨범'}));
 await screen.findByText('앨범 A');expect(screen.queryByText('여행')).toBeNull();
 fireEvent.change(screen.getByRole('searchbox',{name:'앨범 찾기'}),{target:{value:'여행'}});
 const result=screen.getByRole('button',{name:'여행, 앨범 A'});
 expect(result.className).toBe('library-result');expect(result.querySelector('small')?.textContent).toBe('앨범 A');
 fireEvent.click(result);expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({album:{id:'b',libraryId:tree.libraryId,epoch:1}}));
 expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.change(screen.getByRole('searchbox',{name:'앨범 찾기'}),{target:{value:'missing'}});
 expect(screen.getByText('일치하는 앨범이 없습니다.')).toBeTruthy();
});
it('aligns cards at the top with an identical cover boundary in grids and strips',()=>{
 const folders=[{id:'a',name:'Parent',parent_id:null,asset_count:1},{id:'b',name:'Plain',parent_id:null,asset_count:0},{id:'c',name:'Child',parent_id:'a',asset_count:1}];
 const view=render(<FolderCards items={folders.slice(0,2)} entries={folders} paused revision={1} onSelect={()=>{}}/>);
 for(const strip of [false,true]) {
  view.rerender(<FolderCards items={folders.slice(0,2)} entries={folders} paused revision={1} strip={strip} onSelect={()=>{}}/>);
  const cards=view.container.querySelectorAll('.library-folder');expect(cards).toHaveLength(2);
  cards.forEach(card=>expect(card.firstElementChild?.classList.contains('home-cover-group')).toBe(true));
  expect(cards[0].querySelector('small')).not.toBeNull();expect(cards[1].querySelector('small')).toBeNull();
 }
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
