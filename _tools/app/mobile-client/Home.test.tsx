import {cleanup, fireEvent, render, screen, waitFor, act} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Home, type HomeProps} from './Home';
import {dayNumber, discoveryFolders, folderBreadcrumb, readRecentFolders, RECENT_FOLDERS_KEY, rememberFolder} from './homeModel';
import type {Classification} from './types';
const mocks = vi.hoisted(() => ({api:vi.fn(),loadThumbnail:vi.fn()}));
vi.mock('./transport',() => ({api:mocks.api}));
vi.mock('./media',() => ({loadThumbnail:mocks.loadThumbnail}));
const folders:Classification[] = Array.from({length:7},(_,index) => ({id:`folder-${index}`,name:`분류 ${index}`,parent_id:index === 1 ? 'folder-0' : null,asset_count:index === 6 ? 0 : index + 1}));
const props = ():HomeProps => ({items:[{id:'recent',kind:'image',creator_name:'최근 작가'}],classifications:folders,recentFolders:[],revisit:{bundles:[]},captures:[],busy:false,paused:false,secondaryError:'',revision:1,onSelect:vi.fn(),onOpen:vi.fn(),onPending:vi.fn()});
beforeEach(() => {localStorage.clear(); mocks.api.mockReset(); mocks.loadThumbnail.mockReset(); mocks.loadThumbnail.mockImplementation(async asset => ({...asset,preview:`blob:${asset.id}`})); mocks.api.mockResolvedValue({items:[{id:'cover',kind:'image'}],has_more:false,next_cursor:null});});
afterEach(cleanup);
describe('classification discovery',() => {
  it('rotates deterministically by local calendar day and only uses populated real IDs',() => {
    const date = new Date(2026,8,7,1);
    expect(dayNumber(date)).toBe(dayNumber(new Date(2026,8,7,23)));
    const today = discoveryFolders(folders,dayNumber(date));
    expect(today).toHaveLength(4);
    expect(today.every(folder => folder.asset_count > 0 && folders.includes(folder))).toBe(true);
    expect(discoveryFolders([...folders].reverse(),dayNumber(date))).toEqual(today);
    expect(discoveryFolders(folders,dayNumber(date)+1)).not.toEqual(today);
    expect(discoveryFolders([])).toEqual([]);
  });
  it('resolves ID breadcrumbs without looping through malformed ancestry',() => {
    expect(folderBreadcrumb(folders[1],folders)).toBe('분류 0 / 분류 1');
    const cycle = [{...folders[0],parent_id:'folder-1'},folders[1]];
    expect(folderBreadcrumb(cycle[0],cycle)).toBe('분류 1 / 분류 0');
  });
  it('gives different roots priority and rotates candidates within each root',() => {
    const item = (id:string,parent_id:string|null,asset_count=1):Classification => ({id,name:id,parent_id,asset_count});
    const branches=[item('a',null,0),item('a1','a'),item('a2','a'),item('a3','a'),item('b',null,0),item('b1','b'),item('b2','b'),item('c',null),item('d',null),item('e',null)];
    expect(discoveryFolders(branches,0).map(folder => folder.id)).toEqual(['a1','b1','c','d']);
    expect(discoveryFolders(branches,1).map(folder => folder.id)).toEqual(['b2','c','d','e']);
    expect(discoveryFolders(branches,5).map(folder => folder.id)).toEqual(['a3','b2','c','d']);
    expect(discoveryFolders(branches.filter(folder => folder.id.startsWith('a')),0)).toHaveLength(3);
    const single=[item('root',null,0),...Array.from({length:6},(_,i)=>item(`child${i}`,'root'))];
    expect(discoveryFolders(single,0).map(folder => folder.id)).toEqual(['child0','child1','child2','child3']);
    expect(discoveryFolders(single,1).map(folder => folder.id)).toEqual(['child1','child2','child3','child4']);
  });
  it('groups cycles consistently and treats missing ancestors as stable roots',() => {
    const input:Classification[]=[{id:'a',name:'A',parent_id:'b',asset_count:1},{id:'b',name:'B',parent_id:'a',asset_count:1},{id:'child',name:'C',parent_id:'b',asset_count:1},{id:'orphan',name:'O',parent_id:'missing',asset_count:1},{id:'other',name:'X',parent_id:null,asset_count:1}];
    expect(discoveryFolders(input,0).map(folder => folder.id)).toEqual(['a','orphan','other','b']);
    expect(discoveryFolders([...input].reverse(),0)).toEqual(discoveryFolders(input,0));
    expect(discoveryFolders(input,-1)).toHaveLength(4);
  });
  it('scopes recent IDs to connection and bounds and deduplicates visits',() => {
    localStorage.setItem(RECENT_FOLDERS_KEY,JSON.stringify({scope:'one',ids:['folder-1']}));
    expect(readRecentFolders('two')).toEqual([]);
    expect(readRecentFolders('one')).toEqual(['folder-1']);
    expect(rememberFolder(['folder-1','folder-2'],'folder-2')).toEqual(['folder-2','folder-1']);
    expect(rememberFolder(folders.map(folder => folder.id),'new')).toHaveLength(6);
  });
  it('paints recent media first, caps preview requests at four with concurrency two, cancels remaining on leave',async() => {
    const resolve:((value:unknown)=>void)[] = [];
    mocks.api.mockImplementation(() => new Promise(done => resolve.push(done)));
    const {unmount} = render(<Home {...props()}/>);
    expect(screen.getByRole('button',{name:/최근 작가/})).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    await act(async() => {resolve[0]({items:[],has_more:false,next_cursor:null});});
    expect(mocks.api).toHaveBeenCalledTimes(3);
    await act(async() => {resolve[1]({items:[],has_more:false,next_cursor:null});});
    expect(mocks.api).toHaveBeenCalledTimes(4);
    expect(mocks.api.mock.calls.every(([path]) => path.includes('limit=3'))).toBe(true);
    unmount();
    expect(mocks.api.mock.calls.every(([,signal]) => signal.aborted)).toBe(true);
    await act(async() => {resolve[2]({items:[],has_more:false,next_cursor:null}); resolve[3]({items:[],has_more:false,next_cursor:null});});
    expect(mocks.api).toHaveBeenCalledTimes(4);
  });
  it('does not start queued folder requests after cancellation',async() => {
    let resolve!:(value:unknown)=>void;
    mocks.api.mockImplementation(() => new Promise(done => {resolve=done;}));
    const {unmount} = render(<Home {...props()}/>);
    unmount(); await act(async() => {resolve({items:[],has_more:false,next_cursor:null});});
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
  it('opens canonical folder/date/creator/library views and recent asset indices',async() => {
    const input = props(); input.recentFolders=['folder-1']; input.revisit={bundles:[{kind:'date',title:'작년의 오늘',items:[{id:'old',kind:'image'}]},{kind:'creator',title:'작가',groups:[{creator_key:'real/key',creator_name:'작가 A',creator_handle:'handle',asset_count:8,items:[{id:'creator',kind:'image'}]}]}]};
    render(<Home {...input}/>);
    fireEvent.click(screen.getByRole('button',{name:'전체 보기'}));
    expect(input.onSelect).toHaveBeenLastCalledWith({tab:'library',title:'최근 저장'});
    expect(screen.queryByRole('region',{name:'최근 방문 분류'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:/날짜별 다시보기 작년의 오늘/}));
    expect(input.onSelect).toHaveBeenLastCalledWith({tab:'library',revisit:'date',title:'작년의 오늘'});
    fireEvent.click(screen.getByRole('button',{name:/작가별 다시보기 작가 A/}));
    expect(input.onSelect).toHaveBeenLastCalledWith({tab:'library',revisit:'real/key',title:'작가 A'});
    fireEvent.click(screen.getByRole('button',{name:/최근 작가/})); expect(input.onOpen).toHaveBeenCalledWith(0);
    await waitFor(() => expect(screen.getByRole('region',{name:'다시보기'}).querySelectorAll('img')).toHaveLength(2));
  });
});
