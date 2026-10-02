import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
const likes=vi.hoisted(()=>({state:{liked:new Set<string>(),available:true,pending:new Set<string>(),error:'',toggle:vi.fn()},calls:[] as unknown[][]}));
vi.mock('./useLikesAlbum',()=>({useLikesAlbum:(...args:unknown[])=>{likes.calls.push(args);return likes.state;}}));
vi.mock('./transport',()=>({api:vi.fn(),native:vi.fn(),ApiError:class extends Error{},errorText:(error:Error)=>error.message}));
vi.mock('./media',()=>({mediaTicket:vi.fn(()=>new Promise(()=>{})),decodeImage:vi.fn(),invalidateTicket:vi.fn(),loadThumbnail:vi.fn(),clearMediaCache:vi.fn(),prepareAssets:vi.fn()}));
vi.mock('./AlbumMembershipEditor',()=>({AlbumMembershipEditor:()=>null}));
vi.mock('./ClassificationAssignmentEditor',()=>({ClassificationAssignmentEditor:()=>null}));
vi.mock('./ViewerInfo',()=>({ViewerInfo:()=>null}));
import {Viewer} from './Viewer';
afterEach(()=>{cleanup();likes.calls.length=0;likes.state.liked=new Set();likes.state.available=true;likes.state.error='';likes.state.toggle.mockReset();});
const items:Asset[]=[{id:'asset-1',kind:'image',preview:'https://test.invalid/1'},{id:'asset-2',kind:'image',preview:'https://test.invalid/2'}];
const view=(index=0)=><Viewer items={items} index={index} onIndex={()=>{}} onClose={()=>{}} endpoint="https://example.invalid"/>;

it('toggles the shown asset in 마음에 들어요 from the viewer bar',()=>{
  likes.state.liked=new Set(['asset-1']);
  const {rerender}=render(view());
  const heart=screen.getByRole('button',{name:'좋아요'});
  expect(heart.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(heart);
  expect(likes.state.toggle).toHaveBeenCalledWith('asset-1');
  expect(likes.calls.at(-1)).toEqual([['asset-1'],true,'asset-1']);
  rerender(view(1));
  expect(screen.getByRole('button',{name:'좋아요'}).getAttribute('aria-pressed')).toBe('false');
  expect(likes.calls.at(-1)).toEqual([['asset-2'],true,'asset-2']);
});
it('hides the heart when the likes album is unavailable and shows write errors',()=>{
  likes.state.available=false;likes.state.error='좋아요를 변경하지 못했습니다.';
  render(view());
  expect(screen.queryByRole('button',{name:'좋아요'})).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('좋아요를 변경하지 못했습니다.');
});
