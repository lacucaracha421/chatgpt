import type {MutableRefObject, ReactNode} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Asset} from './types';
import type {HomeProps} from './Home';

// App-level Back routing for screens opened from Home. The destinations are stand-ins that
// behave like their entry level: Back there calls `onReturnHome` when App passes it.
const mocks = vi.hoisted(() => ({api:vi.fn(), native:vi.fn()}));
vi.mock('./transport', () => ({api:mocks.api, native:mocks.native, errorText:() => 'connection failed',
  ApiError:class ApiError extends Error {status:number|null; details:unknown; constructor(message:string,status:number|null,details:unknown) {super(message); this.status = status; this.details = details;}}}));
vi.mock('./media', () => ({clearMediaCache:vi.fn(), loadThumbnail:vi.fn(async(a) => a), prepareAssets:() => new Promise(() => {})}));
vi.mock('./Home', () => ({Home:(props:HomeProps) => <div className="home-scroll" aria-label="홈 대시보드">
  <button onClick={props.onReleases}>home 신간</button>
  <button onClick={() => props.onWork('w1')}>home 작품</button>
  <button onClick={() => props.onNotes('n1')}>home 메모</button>
  <button onClick={() => props.onNotes()}>home 메모 카드</button>
  <button onClick={props.onDuplicates}>home 중복</button>
  <button onClick={props.onRecent}>home 최근</button>
  <button onClick={props.onLibrary}>home 라이브러리</button>
</div>}));
vi.mock('./Gallery', () => ({Gallery:({intro,items}:{intro?:ReactNode;items:Asset[]}) => <div aria-label="자산 목록">{intro}{items.map(a => <span key={a.id}>{`tile-${a.id}`}</span>)}</div>}));
vi.mock('./Viewer', () => ({Viewer:() => null}));
type AreaProps = {active:boolean; backRef:MutableRefObject<(() => boolean)|null>; onReturnHome?:() => void; onHomeEntryGone?:() => void};
const {area} = vi.hoisted(() => ({area:(name:string) => ({active,backRef,onReturnHome,onHomeEntryGone}:AreaProps) => {
  backRef.current = () => {if (!onReturnHome) return false; onReturnHome(); return true;};
  return active ? <section aria-label={name} data-from-home={String(!!onReturnHome)}>
    {onHomeEntryGone && <button onClick={onHomeEntryGone}>{`${name} entry gone`}</button>}
  </section> : null;
}}));
vi.mock('./Collections', () => ({Collections:area('collections-screen')}));
vi.mock('./Notes', () => ({Notes:area('notes-screen')}));
vi.mock('./Catalog', () => ({Catalog:area('catalog-screen')}));
import {App} from './App';

const a = [{id:'a1',kind:'image'},{id:'a2',kind:'image'}], b = [{id:'b1',kind:'image'}];
const back = () => act(() => {window.dispatchEvent(new Event('lakomics-back'));});
const nav = (name:string) => screen.getByRole('button',{name,exact:true});
const onHome = () => nav('Home').getAttribute('aria-current') === 'page';
async function startHome(scroll = 300) {
  render(<App/>);
  await screen.findByRole('heading',{name:'라이브러리'});
  fireEvent.click(nav('Home'));
  const home = await screen.findByLabelText('홈 대시보드');
  home.scrollTop = scroll;
  return home;
}
const finished = () => mocks.native.mock.calls.some(([command]) => command === 'finish');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver',class {observe() {} disconnect() {}});
  localStorage.clear(); mocks.api.mockReset(); mocks.native.mockReset();
  mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
  mocks.api.mockImplementation(async(path:string) => {
    if (path === '/v1/library/list-generation') return {generation:'a'.repeat(64)};
    if (path.includes('classifications')) return {items:[{id:'b',name:'분류 B',asset_count:1,parent_id:null}]};
    if (path.includes('revisit')) return {bundles:[]}; if (path.includes('captures')) return {captures:[]};
    return {items:path.includes('classification_id=b') ? b : a,has_more:false,next_cursor:null};
  });
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

it.each([
  ['home 신간','collections-screen'],
  ['home 작품','collections-screen'],
  ['home 메모','notes-screen'],
  ['home 중복','catalog-screen'],
])('Back from %s returns to the same Home at its scroll position',async(button,screenName) => {
  const home = await startHome();
  fireEvent.click(screen.getByRole('button',{name:button}));
  expect((await screen.findByRole('region',{name:screenName})).getAttribute('data-from-home')).toBe('true');
  back();
  await waitFor(() => expect(onHome()).toBe(true));
  expect(screen.queryByRole('region',{name:screenName})).toBeNull();
  expect(screen.getByLabelText('홈 대시보드')).toBe(home);
  expect(home.scrollTop).toBe(300);
});

it('opens the Notes list from the 메모 card header without a Home origin (the list is the tab root)',async() => {
  await startHome();
  fireEvent.click(screen.getByRole('button',{name:'home 메모 카드'}));
  expect((await screen.findByRole('region',{name:'notes-screen'})).getAttribute('data-from-home')).toBe('false');
});

it('forgets the Home origin when the bottom navigation switches tabs',async() => {
  await startHome();
  fireEvent.click(screen.getByRole('button',{name:'home 신간'}));
  await screen.findByRole('region',{name:'collections-screen'});
  fireEvent.click(nav('Catalog'));
  fireEvent.click(nav('Collections'));
  expect(screen.getByRole('region',{name:'collections-screen'}).getAttribute('data-from-home')).toBe('false');
  // Library opened from Home, then reselected from the bottom nav: its root Back exits as before.
  fireEvent.click(nav('Home'));
  await waitFor(() => expect(onHome()).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'home 최근'}));
  await screen.findByText('tile-a1');
  fireEvent.click(nav('Library'));
  await screen.findByRole('heading',{name:'라이브러리'});
  back();
  await waitFor(() => expect(finished()).toBe(true));
  expect(onHome()).toBe(false);
});

it('returns from the recent saves opened from Home to Home, restoring its scroll',async() => {
  await startHome(260);
  fireEvent.click(screen.getByRole('button',{name:'home 최근'}));
  await waitFor(() => expect(screen.queryByLabelText('홈 대시보드')).toBeNull());
  await screen.findByText('tile-a1');
  back();
  const home = await screen.findByLabelText('홈 대시보드');
  expect(onHome()).toBe(true);
  expect(home.scrollTop).toBe(260);
  expect(finished()).toBe(false);
});

it('steps back inside Library before returning Home when the Library was opened from Home',async() => {
  await startHome();
  fireEvent.click(screen.getByRole('button',{name:'home 라이브러리'}));
  fireEvent.click(await screen.findByRole('button',{name:'분류 B, 1개'}));
  await screen.findByText('tile-b1');
  back();
  // The folder was a deeper level: Back goes to the Library entry first.
  await screen.findByRole('heading',{name:'라이브러리'});
  expect(onHome()).toBe(false);
  back();
  expect((await screen.findByLabelText('홈 대시보드')).scrollTop).toBe(300);
  expect(onHome()).toBe(true);
  expect(finished()).toBe(false);
});

it('keeps Back unchanged for screens reached without Home',async() => {
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
  fireEvent.click(nav('Collections'));
  expect((await screen.findByRole('region',{name:'collections-screen'})).getAttribute('data-from-home')).toBe('false');
  // The tab root falls back to the assets area it was opened over (the Library folder), not Home.
  back();
  await waitFor(() => expect(screen.queryByRole('region',{name:'collections-screen'})).toBeNull());
  expect(nav('Library').getAttribute('aria-current')).toBe('page');
  expect(onHome()).toBe(false);
});

it('forgets the Notes Home origin once the note opened from Home is trashed (Back then leaves like a tab visit)',async() => {
  await startHome();
  fireEvent.click(screen.getByRole('button',{name:'home 메모'}));
  const notes = await screen.findByRole('region',{name:'notes-screen'});
  expect(notes.getAttribute('data-from-home')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'notes-screen entry gone'}));
  await waitFor(() => expect(screen.getByRole('region',{name:'notes-screen'}).getAttribute('data-from-home')).toBe('false'));
  expect(screen.queryByRole('button',{name:'notes-screen entry gone'})).toBeNull();
  // The list root falls back to the assets area it was opened over, which is Home here.
  back();
  await waitFor(() => expect(onHome()).toBe(true));
  expect(finished()).toBe(false);
});
