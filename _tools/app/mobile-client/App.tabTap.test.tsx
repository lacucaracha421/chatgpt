import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {MutableRefObject} from 'react';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:()=> 'failed'}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async a=>a),prepareAssets:()=>new Promise(()=>{}),mediaTicket:vi.fn(async()=>({url:'https://test/cover'}))}));
vi.mock('./Home',()=>({Home:()=> <div aria-label="home-content"/>}));
vi.mock('./Gallery',()=>({Gallery:({items}:{items:Asset[]})=><div aria-label="gallery-content">{items.map(item=><span key={item.id}>{item.id}</span>)}</div>}));
vi.mock('./Collections',()=>({Collections:({active,backRef}:{active:boolean;backRef:MutableRefObject<(()=>boolean)|null>})=>{backRef.current=()=>false;return active?<section aria-label="collections-screen"/>:null;}}));
vi.mock('./Notes',()=>({Notes:()=>null}));
vi.mock('./Catalog',()=>({Catalog:()=>null}));
import {App} from './App';
const nav=(label:string)=>within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:label,exact:true});
const current=()=>['홈','에셋','컬렉션'].filter(label=>nav(label).getAttribute('aria-current')==='page');
const generation=(value:string)=>({generation:value.repeat(64)});
let hold:{path:string;finish(value:unknown):void}[]|null=null;
beforeEach(()=>{
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();hold=null;
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  window.LakomicsNative={localStatus:()=>JSON.stringify({configured:true,endpoint:'https://test'})};
  mocks.native.mockImplementation(async()=>({configured:true,endpoint:'https://test'}));
  mocks.api.mockImplementation((path:string)=>{
    if(path.includes('list-generation'))return Promise.resolve(generation('a'));
    if(path.includes('classifications'))return Promise.resolve({items:[]});
    if(path.includes('characters'))return Promise.resolve({ready:false,nodes:[],scopes:[]});
    if(path.includes('revisit'))return Promise.resolve({bundles:[]});
    if(path.includes('captures'))return Promise.resolve({captures:[]});
    if(path.startsWith('/v1/library/assets?')){
      const page={items:[{id:'asset-1',kind:'image'}],has_more:false,next_cursor:null,list_generation:'a'.repeat(64)};
      if(hold)return new Promise(finish=>hold!.push({path,finish:()=>finish(page)}));
      return Promise.resolve(page);
    }
    return Promise.resolve({items:[]});
  });
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();delete window.LakomicsNative;});
async function startOnHome(){
  render(<App/>);
  await act(async()=>{window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:generation('a')}));});
  await waitFor(()=>expect(current()).toEqual(['홈']));
}
it('tapping 에셋 from another tab never shows Home first',async()=>{
  await startOnHome();
  fireEvent.click(nav('컬렉션'));await screen.findByLabelText('collections-screen');
  hold=[];
  const seen:string[][]=[];
  fireEvent.click(nav('에셋'));
  const homeShown=()=>{const layer=screen.queryByLabelText('home-content')?.closest<HTMLElement>('[data-motion-view]');return !!layer&&layer.style.display!=='none'&&layer.style.visibility!=='hidden';};
  seen.push(current());
  expect(homeShown()).toBe(false);
  await act(async()=>{await Promise.resolve();});
  seen.push(current());
  expect(homeShown()).toBe(false);
  await act(async()=>{hold!.forEach(item=>item.finish(null));});
  await waitFor(()=>expect(current()).toEqual(['에셋']));
  expect(seen.flat()).not.toContain('홈');
});
it('a native generation announced right after the first tap keeps 에셋',async()=>{
  await startOnHome();
  hold=[];
  fireEvent.click(nav('에셋'));
  await act(async()=>{window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:generation('b')}));});
  await act(async()=>{hold!.forEach(item=>item.finish(null));});
  await act(async()=>{await Promise.resolve();});
  await act(async()=>{hold!.forEach(item=>item.finish(null));});
  await waitFor(()=>expect(current()).toEqual(['에셋']));
});
it('tapping 홈 from another tab never shows Library first',async()=>{
  await startOnHome();
  fireEvent.click(nav('에셋'));await waitFor(()=>expect(current()).toEqual(['에셋']));
  fireEvent.click(nav('컬렉션'));await screen.findByLabelText('collections-screen');
  // Home's cached page is older than a minute, so tapping 홈 reads it again.
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+120_000);
  hold=[];
  fireEvent.click(nav('홈'));
  expect(current()).toEqual(['컬렉션']);
  expect(screen.queryByLabelText('gallery-content')?.closest<HTMLElement>('[data-motion-view]')?.style.display).not.toBe('');
  await act(async()=>{hold!.forEach(item=>item.finish(null));});
  await waitFor(()=>expect(current()).toEqual(['홈']));
  vi.restoreAllMocks();
});
const route={area:'collections',tab:'library',position:{view:{tab:'library',classification:'folder-id',title:'폴더'},cursor:null,previous:[],scroll:120,filters:{}}};
afterEach(()=>{window.history.replaceState(null,'','/');});
it('a normal launch starts on Home even when a route was remembered',async()=>{
  localStorage.setItem('lakomics.mobile.route',JSON.stringify(route));
  await startOnHome();
  expect(current()).toEqual(['홈']);
  expect(screen.queryByLabelText('collections-screen')).toBeNull();
});
it('a recreated activity (?restore=1) reopens the remembered tab and its Library place',async()=>{
  localStorage.setItem('lakomics.mobile.route',JSON.stringify(route));
  window.history.replaceState(null,'','/?restore=1');
  render(<App/>);
  await screen.findByLabelText('collections-screen');
  expect(current()).toEqual(['컬렉션']);
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>String(path).startsWith('/v1/library/assets?')&&String(path).includes('classification_id=folder-id'))).toBe(true));
  fireEvent.click(nav('에셋'));
  await waitFor(()=>expect(current()).toEqual(['에셋']));
  expect((await screen.findByLabelText('gallery-content')).textContent).toContain('asset-1');
});
it('remembers the tab and Library place once a page has committed',async()=>{
  await startOnHome();
  fireEvent.click(nav('에셋'));await waitFor(()=>expect(current()).toEqual(['에셋']));
  fireEvent.click(nav('컬렉션'));await screen.findByLabelText('collections-screen');
  const saved=JSON.parse(localStorage.getItem('lakomics.mobile.route')!);
  expect(saved.area).toBe('collections');expect(saved.tab).toBe('library');expect(saved.position.view.root).toBe(true);
});
