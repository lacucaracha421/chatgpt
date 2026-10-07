import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {NotesStore, type Note} from '../src/notes/store';
import {TRASH_SECTION_STORAGE_KEY, TRASH_EMPTY} from '../src/safety/trashSections';
import {mobileNotesRequest} from './notesTransport';
import {setOutboxConnection} from './outboxConnection';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',async()=>({...await vi.importActual<typeof import('./transport')>('./transport'),api:mocks.api,native:mocks.native}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {TrashLayer} from './TrashLayer';
import {useTabletTrashCount, setTabletTrashCount} from './trashCounts';

const identity={libraryId:'e'.repeat(32),epoch:5,contractVersion:1};
const deleted:Note={id:'a'.repeat(32),title:'지운 메모',body:'보관한 내용',deleted:true,pinned:false,createdAt:'2026-10-01',updatedAt:'2026-10-06',localRevision:1,pending:false,conflict:false};
const work={workId:'old',type:'movie',name:'지운 영화',trashedAt:'2026-10-06',purgeAt:'2030-10-10',entityRevision:4};
beforeEach(()=>{
  localStorage.clear();setOutboxConnection('https://trash-test.example');mocks.api.mockReset();mocks.native.mockReset();
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/collections/authority/status')return {...identity,active:true};
    if(path.startsWith('/v1/collections/authority/trash?'))return {...identity,items:[work]};
    if(path.startsWith('/v1/library/trash'))return {active:true,items:[{id:'asset',kind:'image',thumbnail_available:false,trashedAt:'2026-10-06',entityRevision:7}],total_count:1,total_bytes:1024,next_cursor:null,has_more:false};
    return {items:[]};
  });
  mocks.native.mockImplementation(async(op:string,input:Record<string,unknown>)=>{
    if(op==='notesSave')return {...deleted,...input,localRevision:2,pending:true};
    if(op.startsWith('notes'))return {unlocked:true,notes:[deleted]};
    return {available:true,items:[]};
  });
});
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks();});
function mount(store=new NotesStore(mobileNotesRequest)) {
  const close=vi.fn(), restored=vi.fn(), backRef={current:null as (()=>boolean)|null};
  return {...render(<TrashLayer endpoint="https://trash-test.example" store={store} known={new Map()} onRestored={restored} onClose={close} backRef={backRef}/>),store,close,restored,backRef};
}
it('shows shared tab order and counts and remembers the selected section on reopening',async()=>{
  const view=mount();
  await screen.findByRole('tab',{name:'메모 1'});await screen.findByRole('tab',{name:'컬렉션 1'});await screen.findByRole('tab',{name:'에셋 1'});
  expect(screen.getAllByRole('tab').map(tab=>tab.getAttribute('aria-label'))).toEqual(['에셋 1','컬렉션 1','메모 1']);
  fireEvent.click(screen.getByRole('tab',{name:'메모 1'}));await screen.findByText('지운 메모');
  expect(localStorage.getItem(TRASH_SECTION_STORAGE_KEY)).toBe('notes');
  view.unmount();mount();
  expect(screen.getByRole('tab',{name:'메모'}).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('지운 메모')).toBeTruthy();
});
it('keeps old rows inert until the next section is ready and retains the asset selection',async()=>{
  let finish!:(value:unknown)=>void;
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string,...args:unknown[])=>path.startsWith('/v1/collections/authority/trash?')?new Promise(resolve=>{finish=resolve;}):original(path,...args));
  const view=mount();const asset=await screen.findByRole('button',{pressed:false});fireEvent.click(asset);
  fireEvent.click(screen.getByRole('tab',{name:'컬렉션'}));
  expect(asset.isConnected).toBe(true);expect(asset.closest('.trash-section')?.getAttribute('style') ?? '').not.toContain('display: none');
  expect(view.container.querySelector('.trash-sections')?.hasAttribute('inert')).toBe(true);
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  await act(async()=>finish({...identity,items:[work]}));await screen.findByText('지운 영화');
  fireEvent.click(screen.getByRole('tab',{name:'에셋 1'}));
  expect(screen.getByRole('button',{pressed:true})).toBe(asset);
  expect(screen.getByText('1개 선택')).toBeTruthy();
});
it('restores assets through their existing revision-aware path and Back returns to the opener',async()=>{
  const view=mount();fireEvent.click(await screen.findByRole('button',{pressed:false}));
  fireEvent.click(screen.getByRole('button',{name:'복원'}));
  await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('assetLifecycleSet',{assetId:'asset',command:'restore',seenRevision:7}));
  await waitFor(()=>expect(view.restored).toHaveBeenCalledWith(['asset']));
  act(()=>{expect(view.backRef.current?.()).toBe(true);});expect(view.close).toHaveBeenCalledOnce();
});
it('restores deleted notes with the shared NotesStore and updates the tab count',async()=>{
  localStorage.setItem(TRASH_SECTION_STORAGE_KEY,'notes');mount();
  fireEvent.click(await screen.findByRole('button',{name:'지운 메모 되살리기'}));
  await waitFor(()=>expect(mocks.native.mock.calls.some(([op,input])=>op==='notesSave'&&input.id===deleted.id&&input.deleted===false)).toBe(true));
  expect(await screen.findByText(TRASH_EMPTY)).toBeTruthy();
  expect(screen.getByRole('tab',{name:'메모'})).toBeTruthy();
});
it('retries collection failures in place without showing an empty state',async()=>{
  localStorage.setItem(TRASH_SECTION_STORAGE_KEY,'collections');
  const original=mocks.api.getMockImplementation()!;let offline=true;
  mocks.api.mockImplementation((path:string,...args:unknown[])=>path.startsWith('/v1/collections/authority/trash?')&&offline?Promise.reject(new Error('오프라인')):original(path,...args));
  mount();await screen.findByRole('alert');expect(screen.queryByText(TRASH_EMPTY)).toBeNull();
  offline=false;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));expect(await screen.findByText('지운 영화')).toBeTruthy();
});
it('rechecks authority on retry after the initial connection check fails',async()=>{
  localStorage.setItem(TRASH_SECTION_STORAGE_KEY,'collections');
  const original=mocks.api.getMockImplementation()!;let offline=true;
  mocks.api.mockImplementation((path:string,...args:unknown[])=>path==='/v1/collections/authority/status'&&offline?Promise.reject(new Error('연결 실패')):original(path,...args));
  mount();await screen.findByText('연결 실패');
  offline=false;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
  expect(await screen.findByText('지운 영화')).toBeTruthy();
});
it('sums cached counts and deleted notes without reading trash when More opens',async()=>{
  const endpoint='https://count-test.example',store=new NotesStore(mobileNotesRequest);
  await store.load();setTabletTrashCount(endpoint,'assets',5);setTabletTrashCount(endpoint,'collections',2);
  function Count(){return <span>{useTabletTrashCount(endpoint,store)}</span>;}
  render(<Count/>);expect(screen.getByText('8')).toBeTruthy();expect(mocks.api).not.toHaveBeenCalled();
});
