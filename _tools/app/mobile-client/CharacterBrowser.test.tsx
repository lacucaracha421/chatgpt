import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
import {CharacterBrowser} from './CharacterBrowser';
import type {CharacterIndex,CharacterPage} from './characterModel';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(e:Error)=>e.message}));
vi.mock('./media',()=>({loadThumbnail:vi.fn(async(a:Asset)=>({...a,preview:'data:image/png;base64,AA=='}))}));
vi.mock('./Gallery',()=>({Gallery:({items,onOpen,onNearEnd,restoreScroll,intro}:{intro?:import('react').ReactNode;items:Asset[];onOpen(i:number):void;onNearEnd():void;restoreScroll:number})=><div aria-label="character gallery" data-scroll={restoreScroll}>{intro}{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{a.id}</button>)}<button onClick={onNearEnd}>more</button></div>}));
const revision='a'.repeat(64);
const node=(kind:'series'|'group'|'character',id:string,name:string,parentId:string|null)=>({id:`${kind}:${id}`,kind,sourceId:id,seriesId:'s',parentId,name,description:'',thumbnailAssetId:null,manualOnly:false,excluded:false});
const index:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,publishedAt:'2026',nodes:[node('series','s','Series',null),node('group','g','Group','series:s'),node('character','c','Character','group:g')],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'series:s',filter:'unclassified',totalCount:0,sourceCount:0},{nodeId:'series:s',filter:'needs_review',totalCount:0,sourceCount:0},{nodeId:'group:g',filter:'all',totalCount:2,sourceCount:2},{nodeId:'character:c',filter:'all',totalCount:2,sourceCount:3}]};
const page=(ids=['asset-1','asset-2'],cursor:string|null=null):CharacterPage=>({revision,items:ids.map(id=>({id,kind:'image'})),totalCount:2,sourceCount:3,has_more:!!cursor,next_cursor:cursor});
const backRef:{current:(()=>boolean)|null}={current:null};
const onOpen=vi.fn();
const props={active:true,paused:false,density:1,refreshKey:1,onOpen,backRef};
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  mocks.api.mockReset();onOpen.mockReset();backRef.current=null;
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?structuredClone(index):page());
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('navigates series, groups and characters, opens shared assets and returns to parents',async()=>{
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2개'}));
  fireEvent.click(await screen.findByRole('button',{name:'Character · 2개'}));
  fireEvent.click(await screen.findByText('asset-2'));
  expect(onOpen).toHaveBeenCalledWith(page().items,1);
  expect(screen.getByText(/아직 공유되지 않은 자산 1개/)).toBeTruthy();
  act(()=>{expect(backRef.current?.()).toBe(true);});
  expect(await screen.findByRole('heading',{name:'Group'})).toBeTruthy();
  act(()=>{backRef.current?.();});
  expect(await screen.findByRole('heading',{name:'Series'})).toBeTruthy();
  expect(mocks.api.mock.calls.some(([p])=>p.includes('node=character%3Ac')&&p.includes(`revision=${revision}`))).toBe(true);
});

it('rejects a late page after changing the series filter',async()=>{
  let finish!:(p:CharacterPage)=>void;
  mocks.api.mockImplementation((path:string)=>{
    if(path.endsWith('/characters'))return Promise.resolve(structuredClone(index));
    if(path.includes('filter=all'))return new Promise(resolve=>{finish=resolve;});
    return Promise.resolve(page([]));
  });
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
  await waitFor(()=>expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole('button',{name:'미분류'}));
  await screen.findByText('이 보기에 자산이 없습니다');
  await act(async()=>finish(page(['late'])));
  expect(screen.queryByText('late')).toBeNull();
});

it('keeps loaded items on append failure and retries without duplicate assets',async()=>{
  let fail=true;
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    if(path.includes('cursor=next')){if(fail)throw new Error('offline');return page(['asset-1','asset-2']);}
    return page(['asset-1'],'next');
  });
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
  fireEvent.click(await screen.findByRole('button',{name:'more'}));
  await screen.findByText('offline');expect(screen.getByText('asset-1')).toBeTruthy();
  fail=false;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
  await screen.findByText('asset-2');expect(screen.getAllByText('asset-1')).toHaveLength(1);
});

it('refreshes a changed revision and returns to root if the selected character disappears',async()=>{
  const result=render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
  await screen.findByText('asset-1');
  mocks.api.mockResolvedValue({...index,revision:'b'.repeat(64),nodes:[],scopes:[]});
  result.rerender(<CharacterBrowser {...props} refreshKey={2}/>);
  await screen.findByText('등록된 시리즈가 없습니다');
  expect(screen.queryByText('asset-1')).toBeNull();
});

it('distinguishes an older server from an unpublished character view',async()=>{
  mocks.api.mockRejectedValue(Object.assign(new Error('missing'),{status:404}));
  render(<CharacterBrowser {...props}/>);
  await screen.findByText('서버에 캐릭터 보기 업데이트가 필요합니다.');
  mocks.api.mockResolvedValue({...index,ready:false,revision:null,nodes:[],scopes:[]});
  fireEvent.click(screen.getByRole('button',{name:'새로고침'}));
  await screen.findByText('캐릭터 보기가 아직 공유되지 않았습니다');
});

 it('uses the PC overview in landscape and keeps the compact portrait view on rotation',async()=>{
  let rotate!:()=>void;
  const media={matches:true,addEventListener:(_name:string,listener:()=>void)=>{rotate=listener;},removeEventListener:()=>{}};
  vi.stubGlobal('matchMedia',()=>media);
  const withHero=structuredClone(index);withHero.nodes[0].heroAssetId='hero';
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?withHero:page());
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
  const hero=await screen.findByRole('img',{name:'Series 대표 이미지'});
  expect(screen.getByLabelText('character gallery').contains(hero)).toBe(true);
  expect(screen.getByRole('navigation',{name:'캐릭터 위치'})).toBeTruthy();
  await screen.findByText('asset-1');
  act(()=>{media.matches=false;rotate();});
  expect(screen.queryByRole('img',{name:'Series 대표 이미지'})).toBeNull();
  expect(screen.queryByRole('navigation',{name:'캐릭터 위치'})).toBeNull();
  expect(screen.getByText('asset-1')).toBeTruthy();
});
