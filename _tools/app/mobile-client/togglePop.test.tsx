import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
import type {CollectionDetail} from './collectionModel';
import type {PersonalEdits} from './CollectionPersonal';
const pop=vi.hoisted(()=>({popToggle:vi.fn()}));
const likes=vi.hoisted(()=>({state:{liked:new Set<string>(),available:true,pending:new Set<string>(),error:'',toggle:vi.fn()}}));
vi.mock('../src/shared/motion/togglePop',()=>pop);
vi.mock('./useLikesAlbum',()=>({useLikesAlbum:()=>likes.state}));
vi.mock('./transport',()=>({api:vi.fn(),native:vi.fn(),ApiError:class extends Error{},errorText:(error:Error)=>error.message}));
vi.mock('./media',()=>({mediaTicket:vi.fn(()=>new Promise(()=>{})),decodeImage:vi.fn(),invalidateTicket:vi.fn(),loadThumbnail:vi.fn(),clearMediaCache:vi.fn(),prepareAssets:vi.fn()}));
vi.mock('./AlbumMembershipEditor',()=>({AlbumMembershipEditor:()=>null}));
vi.mock('./ClassificationAssignmentEditor',()=>({ClassificationAssignmentEditor:()=>null}));
vi.mock('./ViewerInfo',()=>({ViewerInfo:()=>null}));
import {Viewer} from './Viewer';
import {PersonalActions} from './CollectionPersonal';
afterEach(()=>{cleanup();pop.popToggle.mockReset();likes.state.liked=new Set();likes.state.toggle.mockReset();});
const items:Asset[]=[{id:'asset-1',kind:'image',preview:'https://test.invalid/1'},{id:'asset-2',kind:'image',preview:'https://test.invalid/2'}];

it('pops the viewer heart on a tap, keyed to the shown asset, and never on open',()=>{
  likes.state.liked=new Set(['asset-2']);
  const {rerender}=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}} endpoint="https://example.invalid"/>);
  rerender(<Viewer items={items} index={1} onIndex={()=>{}} onClose={()=>{}} endpoint="https://example.invalid"/>);
  expect(pop.popToggle).not.toHaveBeenCalled();
  const heart=screen.getByRole('button',{name:'좋아요'});
  expect(heart.getAttribute('data-toggle-key')).toBe('asset-2');
  fireEvent.click(heart);
  expect(pop.popToggle).toHaveBeenCalledExactlyOnceWith(heart,false);
  expect(likes.state.toggle).toHaveBeenCalledWith('asset-2');
});

it('pops the work screen showcase toggle with the state it turns to',()=>{
  const item={id:'w',name:'밤의 도서관',type:'game',showcase:false,myScore:null,description:'',overview:null,volumes:[],artworks:[]} as unknown as CollectionDetail;
  function Harness() {
    const [showcase,setShowcase]=useState(false);
    const edits={supported:true,trackingSupported:false,recordSupported:false,failure:'',notice:'',
      edit:(_id:string,_field:string,value:unknown)=>setShowcase(value as boolean),resolveConflict:()=>{},
      visible:(_id:string,field:string,authoritative:unknown)=>({value:field==='showcase'?showcase:authoritative,pending:false})} as unknown as PersonalEdits;
    return <PersonalActions item={item} edits={edits}/>;
  }
  render(<Harness/>);
  expect(pop.popToggle).not.toHaveBeenCalled();
  const star=screen.getByRole('button',{name:'쇼케이스'});
  fireEvent.click(star);
  expect(pop.popToggle).toHaveBeenLastCalledWith(star,true);
  expect(star.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(star);
  expect(pop.popToggle).toHaveBeenLastCalledWith(star,false);
  expect(pop.popToggle).toHaveBeenCalledTimes(2);
});
