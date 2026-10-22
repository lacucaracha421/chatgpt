import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:'connection failed',
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a)=>a),prepareAssets:()=>new Promise(()=>{})}));
vi.mock('./Home',()=>({Home:()=>null}));
vi.mock('./Gallery',()=>({Gallery:({intro,items}:{intro?:ReactNode;items:Asset[]})=><div className="gallery-scroll" aria-label="자산 목록">{intro}{items.map(a=><button key={a.id}>{`tile-${a.id}`}</button>)}</div>}));
import {App} from './App';

const AUTHORITY={libraryId:'a'.repeat(32),epoch:1,contractVersion:1};
const folders=[
  {id:'p',name:'부모',asset_count:2,parent_id:null,total_asset_count:9},
  {id:'c',name:'자식',asset_count:3,parent_id:'p',total_asset_count:3},
  {id:'q',name:'혼자',asset_count:4,parent_id:null,total_asset_count:4},
];
let pins:string[];
const pinReply=()=>({version:1,revision:1,pinnedIds:[...pins]});
beforeEach(()=>{
  pins=[];
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
  mocks.api.mockImplementation(async(path:string,_signal?:unknown,body?:{commands?:{op:string;ids:string[]}[]},method?:string)=>{
    if(path==='/v1/library/list-generation')return{generation:'a'.repeat(64),filterVersion:1};
    if(path==='/v1/library/folder-pins'){
      if(method==='POST')for(const command of body?.commands??[])pins=command.op==='add'?[...pins,...command.ids.filter(id=>!pins.includes(id))]:pins.filter(id=>!command.ids.includes(id));
      return pinReply();
    }
    if(path.startsWith('/v1/library/classifications'))return{items:folders,listVersion:2,authority:AUTHORITY};
    if(path.includes('revisit'))return{bundles:[]};if(path.includes('captures'))return{captures:[]};
    return{items:[{id:'a1',kind:'image',width:100,height:100}],has_more:false,next_cursor:null,filterVersion:1};
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});

const place=(name:string)=>screen.findByRole('heading',{level:1,name:new RegExp(`^${name}`)});
const press=(label:string)=>fireEvent.click(screen.getByRole('button',{name:label}));
async function hold(target:HTMLElement){
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  fireEvent.pointerDown(target,{button:0,clientX:30,clientY:30});
  await act(async()=>{vi.advanceTimersByTime(450);});
  fireEvent.pointerUp(target,{button:0});
  vi.useRealTimers();
}
const back=()=>act(()=>{window.dispatchEvent(new Event('lakomics-back'));});

it('goes back to where a drawer jump started, then up the folders when no visit is left',async()=>{
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:/^혼자/}));
  await place('혼자');
  press('폴더 서랍');
  const drawer=await screen.findByRole('dialog',{name:'폴더 서랍'});
  fireEvent.click(within(drawer).getByRole('button',{name:'부모',exact:true}));
  await place('부모');
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'폴더 서랍'})).toBeNull());
  // 부모 is a top-level folder, so the parent would be the root; the visit before it was 혼자.
  back();
  await place('혼자');
  back();
  await waitFor(()=>expect(screen.queryByRole('button',{name:'뒤로'})).toBeNull());
});

it('shows the folder pinned from its long-press sheet in the drawer, and unpins it from there', async()=>{
  render(<App/>);
  await hold(await screen.findByRole('button',{name:/^혼자/}));
  fireEvent.click(within(await screen.findByRole('dialog',{name:'혼자'})).getByRole('button',{name:'고정'}));
  await waitFor(()=>expect(pins).toEqual(['q']));
  const card=await screen.findByRole('button',{name:'혼자, 4개'});
  // The click that follows a hold is swallowed; the next one opens the folder.
  fireEvent.click(card);fireEvent.click(card);
  await place('혼자');
  press('폴더 서랍');
  const drawer=await screen.findByRole('dialog',{name:'폴더 서랍'});
  const pinned=within(within(drawer).getByRole('group',{name:'고정한 폴더'})).getByRole('button',{name:'혼자'});
  await hold(pinned);
  fireEvent.click(within(await screen.findByRole('dialog',{name:'혼자'})).getByRole('button',{name:'고정 해제'}));
  await waitFor(()=>expect(pins).toEqual([]));
  await waitFor(()=>expect(within(drawer).queryByRole('group',{name:'고정한 폴더'})).toBeNull());
});

it('closes only the open folder drawer on one Back, whichever listener sees the press first',async()=>{
  // A WebView that runs listeners at `window` in registration order lets the shell see Back before the drawer's capturing listener.
  const add=window.addEventListener.bind(window);
  vi.spyOn(window,'addEventListener').mockImplementation(((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>add(type,listener,type==='lakomics-back'?false:options)) as typeof window.addEventListener);
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:/^혼자/}));
  await place('혼자');
  press('폴더 서랍');
  await screen.findByRole('dialog',{name:'폴더 서랍'});
  back();
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'폴더 서랍'})).toBeNull());
  await place('혼자');
  expect(mocks.native).not.toHaveBeenCalledWith('finish');
});
