import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {HomeProps} from './Home';
import type {CollectionDetail} from './collectionModel';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',async()=>({...await vi.importActual<typeof import('./transport')>('./transport'),...mocks}));
vi.mock('./Home',()=>({Home:({onWork}:HomeProps)=><div className="home-scroll" aria-label="Home origin"><button onClick={()=>onWork('entry')}>Playing game</button></div>}));
vi.mock('./useAreaPrewarm',()=>({useAreaPrewarm:()=>({mounted:false,prefetch:false})}));
import {App} from './App';
import {resetReleaseStore} from './releaseStore';

const item:CollectionDetail={id:'entry',name:'Entry work',type:'game',showcase:false,selectedWorkArtworkId:'front',selectedHeroArtworkId:'hero',ownedPlatform:'PS5',volumes:[],artworks:[{id:'hero',kind:'hero',selected:true}]};
let detail:ReturnType<typeof Promise.withResolvers<{revision:string;item:CollectionDetail}>>;
const nav=(name:string)=>within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name,exact:true});
beforeEach(()=>{
  localStorage.clear();resetReleaseStore();mocks.api.mockReset();mocks.native.mockReset();
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
  window.LakomicsNative={localStatus:()=>JSON.stringify({configured:true,endpoint:'https://example.invalid'})} as typeof window.LakomicsNative;
  detail=Promise.withResolvers();
  mocks.native.mockImplementation(async(command:string)=>{
    if(command==='status')return {configured:true,endpoint:'https://example.invalid'};
    if(command==='notesState')return {unlocked:true,notes:[],lastSyncedAt:null};
    return {url:'https://example.invalid/art',expires_in:300};
  });
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/collections/entry')return detail.promise;
    if(path==='/v1/library/list-generation')return {generation:'a'.repeat(64)};
    if(path.endsWith('/status'))return {revision:'entry'};
    if(path.startsWith('/v1/collections/releases'))return {revision:1,counts:{unread:0,collections:[]},items:[],nextCursor:null};
    if(path==='/v1/home/upcoming')return {entries:[],wishlist:[]};
    if(path.includes('revisit'))return {bundles:[]};
    if(path.includes('captures'))return {captures:[]};
    return {ready:true,filterVersion:1,revision:'entry',items:[item],has_more:false,next_cursor:null,nextCursor:null};
  });
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();delete window.LakomicsNative;});

it.each(['system','arrow'])('opens directly after its own faces, then %s Back restores Home and its scroll',async(mode)=>{
  const view=render(<App/>);
  const home=await screen.findByLabelText('Home origin');
  home.scrollTop=320;fireEvent.scroll(home);
  fireEvent.click(screen.getByRole('button',{name:'Playing game'}));
  const stage=view.container.querySelector('.app-body > .motion-stage')!;
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path==='/v1/collections/entry')).toBe(true));
  expect(stage.getAttribute('data-motion-active')).toBe('home-work');
  expect(stage.getAttribute('data-motion-shown')).toBe('home');
  expect(home.closest('[inert]')).toBeTruthy();
  // Passing the old outer gate's one-second cap must not reveal the Collections shelf.
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));});
  expect(stage.getAttribute('data-motion-shown')).toBe('home');
  const incoming=view.container.querySelector('[data-motion-view="home-work"]')!;
  expect(incoming.querySelector('.collection-scroll')).toBeNull();
  expect(mocks.api.mock.calls.some(([path])=>path.startsWith('/v1/collections?'))).toBe(false);
  await act(async()=>detail.resolve({revision:'entry',item}));
  await waitFor(()=>expect(incoming.querySelector('.tablet-work .kase img')).toBeTruthy());
  expect(stage.getAttribute('data-motion-shown')).toBe('home');
  await act(async()=>incoming.querySelectorAll('.tablet-work img').forEach(image=>fireEvent.load(image)));
  await waitFor(()=>expect(stage.getAttribute('data-motion-shown')).toBe('home-work'));
  expect(screen.getByRole('heading',{name:item.name})).toBeTruthy();
  expect(incoming.querySelector('.top-bar__crumbs')?.textContent).toBe('홈');
  expect(nav('컬렉션').getAttribute('aria-current')).toBe('page');
  if(mode==='system')act(()=>window.dispatchEvent(new Event('lakomics-back')));
  else fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(()=>expect(stage.getAttribute('data-motion-shown')).toBe('home'));
  expect(screen.getByLabelText('Home origin')).toBe(home);
  expect(home.scrollTop).toBe(320);
  expect(nav('홈').getAttribute('aria-current')).toBe('page');
  // A later Collections tab visit remains a shelf visit, without the Home-opened work.
  fireEvent.click(nav('컬렉션'));
  await waitFor(()=>expect(stage.getAttribute('data-motion-active')).toBe('collections'));
  expect(view.container.querySelector('[data-motion-view="collections"] .motion-stage')?.getAttribute('data-motion-active')).toBe('shelf');
});

it('cancels an unready Home entry with system Back without ever opening a shelf',async()=>{
  const view=render(<App/>);
  const home=await screen.findByLabelText('Home origin');home.scrollTop=180;fireEvent.scroll(home);
  fireEvent.click(screen.getByRole('button',{name:'Playing game'}));
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await act(async()=>detail.resolve({revision:'entry',item}));
  const stage=view.container.querySelector('.app-body > .motion-stage')!;
  expect(stage.getAttribute('data-motion-shown')).toBe('home');
  expect(nav('홈').getAttribute('aria-current')).toBe('page');
  expect(home.scrollTop).toBe(180);
  expect(view.container.querySelector('[data-motion-view="home-work"]')).toBeNull();
});

it('swaps as soon as the work faces are ready without waiting for a tab timer',async()=>{
  const view=render(<App/>);
  await screen.findByLabelText('Home origin');
  await act(async()=>detail.resolve({revision:'entry',item}));
  fireEvent.click(screen.getByRole('button',{name:'Playing game'}));
  const incoming=view.container.querySelector('[data-motion-view="home-work"]')!;
  await waitFor(()=>expect(incoming.querySelector('.tablet-work .kase img')).toBeTruthy());
  vi.useFakeTimers();
  // No tab timeout advances: only the actual images' readiness may release Home.
  await act(async()=>incoming.querySelectorAll('.tablet-work img').forEach(image=>fireEvent.load(image)));
  expect(view.container.querySelector('.app-body > .motion-stage')?.getAttribute('data-motion-shown')).toBe('home-work');
});
