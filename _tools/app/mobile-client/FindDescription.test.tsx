import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FindSheet} from './FindSheet';
import {tabletFindEntries,type TabletFindEntry} from './findData';
import type {CollectionSummary} from './collectionModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),ticket:vi.fn()}));
vi.mock('./transport',async importOriginal=>({...await importOriginal<typeof import('./transport')>(),api:mocks.api}));
vi.mock('./collectionArtwork',()=>({artworkTicket:mocks.ticket,decoded:vi.fn(async()=>{})}));
vi.mock('./media',()=>({mediaTicket:mocks.ticket,decodeImage:vi.fn(async()=>{})}));
let sequence=0,endpoint='test-device';
const asset=(id:string,contentRating:string|null='g')=>({id,kind:'image',contentRating});
const reply=(prefix:string,ready=true)=>({ready,gated:false,items:ready?Array.from({length:6},(_,index)=>asset(`${prefix}${index}`)):[]});
function entries(run=vi.fn()):TabletFindEntry[]{return tabletFindEntries({works:[{item:{id:'1',name:'첫눈내리는마을',type:'manga',showcase:false} as CollectionSummary,revision:'r'}],artists:[],notes:[],folders:[],albums:null,navigate:run});}
function show(props:Partial<Parameters<typeof FindSheet>[0]>={}){return render(<FindSheet open entries={entries()} endpoint={endpoint} privacy={false} onClose={vi.fn()} onDescription={vi.fn()} {...props}/>);}
const type=(value:string)=>fireEvent.change(screen.getByRole('combobox'),{target:{value}});
const settle=async(ms=0)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
const strip=()=>[...document.querySelectorAll('.tablet-find__thumb img')].map(image=>image.getAttribute('src'));
beforeEach(()=>{
  vi.useFakeTimers();localStorage.clear();endpoint=`test-device-${++sequence}`; // answers are cached per endpoint
  mocks.api.mockReset();mocks.ticket.mockReset();
  mocks.ticket.mockImplementation(async(item:{id:string})=>({url:`https://test/${item.id}`}));
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});

it('asks the server only after a 0.4 s typing pause, never per keystroke, and keeps one request per text',async()=>{
  mocks.api.mockResolvedValue(reply('a'));show();
  type('눈');await settle(100);type('눈 내');await settle(100);type('눈 내리는');
  await settle(399);expect(mocks.api).not.toHaveBeenCalled();
  await settle(1);expect(mocks.api).toHaveBeenCalledTimes(1);
  const [path,,,,,connection]=mocks.api.mock.calls[0];
  const url=new URL(path,'https://x');
  expect(url.pathname).toBe('/v1/library/search/description');
  expect(url.searchParams.get('q')).toBe('눈 내리는');expect(url.searchParams.get('limit')).toBe('6');expect(url.searchParams.has('force')).toBe(false);
  expect(connection).toBe(endpoint);
  await settle();expect(strip()).toHaveLength(6);
  const row=screen.getAllByRole('option')[0];
  expect(row.textContent).toContain('‘눈 내리는’ 장면 찾기');expect(row.getAttribute('aria-selected')).toBe('true');
});

it('keeps the old strip until the next answer is ready and Enter opens the result state for the typed text',async()=>{
  let release:(value:unknown)=>void=()=>{};
  mocks.api.mockResolvedValueOnce(reply('a')).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const open=vi.fn();show({onDescription:open});
  type('눈 내리는');await settle(400);await settle();expect(strip()[0]).toBe('https://test/a0');
  type('눈 내리는 겨울');await settle(400);
  expect(strip()).toHaveLength(6);expect(strip()[0]).toBe('https://test/a0'); // old pictures stay while the new answer is pending
  await act(async()=>{release(reply('b'));});await settle();
  expect(strip()[0]).toBe('https://test/b0');
  fireEvent.keyDown(screen.getByRole('combobox'),{key:'Enter'});
  expect(open).toHaveBeenCalledWith('눈 내리는 겨울');
});

it('keeps the scene fallback selected even when captions are not ready',async()=>{
  mocks.api.mockResolvedValue(reply('a',false));
  const navigate=vi.fn(),open=vi.fn();show({entries:entries(navigate),onDescription:open});
  type('눈 내리는');await settle(400);await settle();
  const options=screen.getAllByRole('option');
  expect(options[0].textContent).toContain('아직 준비 중');
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.keyDown(screen.getByRole('combobox'),{key:'Enter'});
  expect(navigate).not.toHaveBeenCalled();expect(open).toHaveBeenCalledWith('눈 내리는');
});
it('does not request scene previews for strong names, even when the scene row is selected',async()=>{
  mocks.api.mockResolvedValue(reply('a'));
  const items=entries();items[0]={...items[0],label:'레베카'};
  show({context:{tab:'assets'},entries:items});type('레베카');await settle(600);
  expect(mocks.api).not.toHaveBeenCalled();expect(strip()).toHaveLength(0);
  expect(screen.getAllByRole('option').at(-1)?.textContent).toContain('장면 찾기');
  fireEvent.keyDown(screen.getByRole('combobox'),{key:'ArrowDown'});await settle(600);
  expect(mocks.api).not.toHaveBeenCalled();expect(strip()).toHaveLength(0);
});
it.each(['collections','manga','notes'] as const)('does not offer scene search on %s',async tab=>{
  show({context:{tab}});type('비 오는 거리');await settle(600);
  expect(mocks.api).not.toHaveBeenCalled();expect(screen.queryByText(/장면 찾기/)).toBeNull();
});

it('shows no row for a lone Latin letter or other scopes, and no pictures in privacy mode',async()=>{
  mocks.api.mockResolvedValue(reply('a'));
  const view=show();type('a');await settle(400);expect(mocks.api).not.toHaveBeenCalled();expect(screen.queryByText(/장면 찾기/)).toBeNull();
  type('눈 내리는');fireEvent.click(screen.getByRole('button',{name:'작품',exact:true}));await settle(400);
  expect(screen.queryByText(/장면 찾기/)).toBeNull();
  view.rerender(<FindSheet open entries={entries()} endpoint={endpoint} privacy onClose={vi.fn()} onDescription={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'전체',exact:true}));await settle(400);await settle();
  expect(screen.getByText(/장면 찾기/)).toBeTruthy();expect(strip()).toHaveLength(0);
});

it('requests no media for masked ratings and shows a quiet failure instead of an error banner',async()=>{
  localStorage.setItem('lakomics.mobile.nsfwFilter','1');
  mocks.api.mockResolvedValueOnce({ready:true,gated:false,items:[asset('safe','g'),asset('unsafe','e'),asset('unknown',null)]});
  show();type('눈 내리는');await settle(400);await settle();
  expect(mocks.ticket.mock.calls.map(([item])=>item.id)).toEqual(['safe']);
  expect(document.querySelectorAll('.tablet-find__thumb .privacy-mask')).toHaveLength(2);
  mocks.api.mockRejectedValueOnce(new Error('연결 실패'));
  type('눈 내리는 겨울');await settle(400);await settle();
  expect(screen.getByText('내용 검색을 할 수 없습니다.')).toBeTruthy();
});

// Exercise the retained feature while the shipped default remains paused.
vi.mock("../nl-search-runtime/enabled.json", () => ({ default: true }));
