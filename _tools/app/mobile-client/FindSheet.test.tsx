import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FindSheet} from './FindSheet';
import {tabletFindEntries,type TabletFindEntry} from './findData';
import {rememberRecent,readRecent} from '../src/shared/findModel';
import type {CollectionSummary} from './collectionModel';
const media=vi.hoisted(()=>({ticket:vi.fn()}));
vi.mock('./collectionArtwork',()=>({artworkTicket:media.ticket,decoded:vi.fn(async()=>{})}));
vi.mock('./media',()=>({mediaTicket:media.ticket}));
const endpoint='test-device';const recentKey=`tablet:${endpoint}`;
function entries(count=8,run=vi.fn()):TabletFindEntry[]{return tabletFindEntries({works:Array.from({length:count},(_,i)=>({item:{id:String(i),name:`별과 ${i}`,type:'manga',showcase:false,coverAssetId:`cover-${i}`} as CollectionSummary,revision:'r'})),artists:[],notes:[{id:'n',title:'별과 메모',type:'text',deleted:false}],folders:[],albums:null,navigate:run});}
function show(props:Partial<Parameters<typeof FindSheet>[0]>={}){return render(<FindSheet open entries={entries()} endpoint={endpoint} privacy={false} onClose={vi.fn()} {...props}/>);}
function type(query:string){fireEvent.change(screen.getByRole('combobox'),{target:{value:query}});}
beforeEach(()=>{localStorage.clear();media.ticket.mockReset();media.ticket.mockResolvedValue({url:'https://test/cover'});});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('focuses the field, shares group limits and expands; all six scope chips stay touch controls',async()=>{
  show();expect(document.activeElement).toBe(screen.getByRole('combobox'));type('별과');
  await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(6));
  expect(screen.getAllByRole('button',{pressed:false})).toHaveLength(5); // five unselected scopes
  fireEvent.click(screen.getByRole('button',{name:'작품 3개 더 보기'}));expect(screen.getAllByRole('option')).toHaveLength(9);
  fireEvent.click(screen.getByRole('button',{name:'메모',exact:true}));await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(1));
  expect(screen.getByRole('option').textContent).toBe('별과 메모');
  expect(screen.queryByRole('button',{name:'명령',exact:true})).toBeNull();
});
it('picks with Enter, closes, and persists only five deduplicated identifiers per device',async()=>{
  const navigate=vi.fn(),close=vi.fn();show({entries:entries(8,navigate),onClose:close});type('별과 2');
  await screen.findByRole('option');fireEvent.keyDown(screen.getByRole('combobox'),{key:'Enter'});
  expect(navigate).toHaveBeenCalledWith({kind:'work',id:'2'});expect(close).toHaveBeenCalledTimes(1);
  for(let i=0;i<8;i++)rememberRecent(recentKey,`work-${i}`);rememberRecent(recentKey,'work-6');
  expect(readRecent(recentKey)).toEqual(['work-6','work-7','work-5','work-4','work-3']);
  cleanup();show();expect(screen.getAllByRole('option')).toHaveLength(5);
  expect(screen.getAllByRole('option')[0].textContent).toContain('별과 6');
  expect(localStorage.getItem('lakomics.find.recent.v1:'+recentKey)).not.toContain('별과');
});
it('hides recent picks and all media/icons in privacy, does not record private picks; toggling live is immediate',async()=>{
  rememberRecent(recentKey,'work-1');const items=entries();const view=show({entries:items});
  expect(screen.getByRole('option').textContent).toContain('별과 1');
  view.rerender(<FindSheet open entries={items} endpoint={endpoint} privacy onClose={vi.fn()}/>);
  expect(screen.queryByRole('option')).toBeNull();type('별과');await screen.findAllByRole('option');
  expect(document.querySelector('.find-entry__media')).toBeNull();expect(media.ticket).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole('option')[0]);expect(readRecent(recentKey)).toEqual(['work-1']);
});
it('ignores Enter throughout IME composition and keyCode 229; commits composed text without blurring',async()=>{
  const navigate=vi.fn();show({entries:entries(8,navigate)});const input=screen.getByRole('combobox');
  type('별과 2');await screen.findByRole('option');
  fireEvent.compositionStart(input);fireEvent.keyDown(input,{key:'Enter'});fireEvent.keyDown(input,{key:'Enter',isComposing:true});
  fireEvent.compositionEnd(input,{data:'별과 2'});fireEvent.keyDown(input,{key:'Enter',keyCode:229});expect(navigate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);fireEvent.keyDown(input,{key:'Enter'});expect(navigate).toHaveBeenCalledOnce();
});
it('keeps existing result nodes while data arrives and fetches covers only for displayed rows, once per session',async()=>{
  const items=entries(),view=show({entries:items});type('별과');await screen.findAllByRole('option');
  await waitFor(()=>expect(media.ticket).toHaveBeenCalledTimes(5));const first=screen.getAllByRole('option')[0];
  view.rerender(<FindSheet open entries={[...items]} endpoint={endpoint} privacy={false} loading onClose={vi.fn()}/>);
  expect(screen.getAllByRole('option')[0]).toBe(first);expect(within(screen.getByRole('listbox')).queryByLabelText('Loading')).toBeNull();
  type('별과 0');await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(1));type('별과');await screen.findAllByRole('option');expect(media.ticket).toHaveBeenCalledTimes(5);
  expect(screen.getAllByRole('option')[0].querySelector('img')?.getAttribute('src')).toBe('https://test/cover');
});

it('resolves recent IDs against current accessible entries and keeps the chosen scope',()=>{
  rememberRecent(recentKey,'missing');rememberRecent(recentKey,'note-n');rememberRecent(recentKey,'work-1');
  show();expect(screen.getAllByRole('option')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'메모',exact:true}));
  expect(screen.getAllByRole('option')).toHaveLength(1);expect(screen.getByRole('option').textContent).toBe('별과 메모');
});
