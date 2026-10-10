import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:()=> 'failed'}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async a=>a),prepareAssets:()=>new Promise(()=>{}),mediaTicket:vi.fn(async()=>({url:'https://test/cover'})),decodeImage:vi.fn(async()=>{})}));
vi.mock('./Home',()=>({Home:()=> <div aria-label="home-content"/>}));
vi.mock('./Gallery',()=>({Gallery:({items,intro}:{items:Asset[];intro:unknown})=><div aria-label="gallery-content">{intro as never}{items.map(item=><span key={item.id}>{item.id}</span>)}</div>}));
vi.mock('./Settings',()=>({Settings:()=> <section aria-label="settings-screen"/>}));
import {App} from './App';
const back=()=>act(()=>{window.dispatchEvent(new Event('lakomics-back'));});
const row=()=>screen.queryAllByRole('option').find(option=>option.textContent?.includes('장면 찾기'));
const descriptionCalls=()=>mocks.api.mock.calls.map(([path])=>new URL(path as string,'https://test')).filter(url=>url.pathname==='/v1/library/search/description');
let reply:(url:URL)=>unknown,sequence=0;
beforeEach(()=>{
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  const endpoint=`https://description-test-${++sequence}`; // answers are cached per endpoint
  window.LakomicsNative={localStatus:()=>JSON.stringify({configured:true,endpoint})};
  mocks.native.mockImplementation(async(op:string)=>op==='notesState'?{unlocked:true,notes:[]}:op==='albumTree'?{adopted:false,albums:[]}:{configured:true,endpoint});
  reply=()=>({ready:true,gated:false,items:[{id:'found-1',kind:'image'},{id:'found-2',kind:'image'}]});
  mocks.api.mockImplementation(async(path:string)=>{
    const url=new URL(path,'https://test');
    if(url.pathname==='/v1/library/search/description')return reply(url);
    if(path.startsWith('/v1/collections?'))return {ready:true,revision:'r',items:[],nextCursor:null};
    if(path==='/v1/library/artists')return {artists:[]};
    if(path.includes('classifications'))return {items:[]};
    if(path.includes('characters'))return {ready:false,nodes:[],scopes:[]};
    if(path.includes('revisit'))return {bundles:[]};if(path.includes('captures'))return {captures:[]};
    if(path.includes('list-generation'))return {generation:'a'.repeat(64)};
    return {items:[{id:'home-image',kind:'image'}],has_more:false,next_cursor:null};
  });
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();delete window.LakomicsNative;});
async function search(query:string){
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:'찾기',exact:true}));
  const input=await screen.findByRole('combobox');fireEvent.change(input,{target:{value:query}});
  await waitFor(()=>expect(descriptionCalls().length).toBeGreaterThan(0),{timeout:2000});
  await waitFor(()=>expect(row()).toBeTruthy());
  fireEvent.keyDown(input,{key:'Enter'});
}

it('Enter opens the 내용 검색 result state in 에셋 and 검색 해제 returns to the view it came from',async()=>{
  await search('눈 내리는 겨울');
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'찾기'})).toBeNull());
  expect((await screen.findByLabelText('gallery-content')).textContent).toContain('found-1');
  expect(screen.getByText('이미지 내용')).toBeTruthy();expect(screen.getByText('관련도순 · 상위 2장')).toBeTruthy();
  const full=descriptionCalls().find(url=>url.searchParams.get('limit')==='200')!;
  expect(full.searchParams.get('q')).toBe('눈 내리는 겨울');expect(full.searchParams.has('force')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'검색 해제'}));
  expect(await screen.findByLabelText('home-content')).toBeTruthy();
  expect(screen.queryByText('이미지 내용')).toBeNull();
});

it('Android Back leaves the result state for the previous view', async()=>{
  await search('눈 내리는 겨울');await screen.findByText('관련도순 · 상위 2장');
  back();expect(await screen.findByLabelText('home-content')).toBeTruthy();
});

it('a turned-away text offers 그래도 가장 비슷한 그림 보기, which asks again with force',async()=>{
  reply=url=>url.searchParams.get('force')==='true'?{ready:true,gated:false,items:[{id:'near-1',kind:'image'}]}:{ready:true,gated:true,items:[]};
  await search('우주 로봇');
  const force=await screen.findByRole('button',{name:'그래도 가장 비슷한 그림 보기'});expect(screen.getByText('검색 결과 없음')).toBeTruthy();
  fireEvent.click(force);
  await waitFor(()=>expect(screen.getByLabelText('gallery-content').textContent).toContain('near-1'));
  expect(descriptionCalls().some(url=>url.searchParams.get('force')==='true'&&url.searchParams.get('limit')==='200')).toBe(true);
  expect(screen.queryByRole('button',{name:'그래도 가장 비슷한 그림 보기'})).toBeNull();
  back(); // forced and unforced steps are one search: Back goes straight to the origin
  expect(await screen.findByLabelText('home-content')).toBeTruthy();
});

it('before captions exist the result state says 아직 준비 중 without an error or force button',async()=>{
  reply=()=>({ready:false,gated:false,items:[]});
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:'찾기',exact:true}));
  const input=await screen.findByRole('combobox');fireEvent.change(input,{target:{value:'눈 내리는'}});
  await screen.findByText('아직 준비 중');
  // The row is informational then, so Enter does not take the result state; tapping the row still shows the state.
  fireEvent.click(row()!);
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'찾기'})).toBeNull());
  expect((await screen.findAllByText('아직 준비 중')).length).toBeGreaterThan(0);
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByRole('button',{name:'그래도 가장 비슷한 그림 보기'})).toBeNull();
});
