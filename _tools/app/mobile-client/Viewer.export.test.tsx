import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Asset} from './types';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,api:vi.fn(()=>new Promise(()=>{})),errorText:(reason:unknown)=>reason instanceof Error?reason.message:''}));
vi.mock('./media',()=>({mediaTicket:vi.fn(()=>new Promise(()=>{})),decodeImage:vi.fn(()=>new Promise(()=>{})),loadThumbnail:vi.fn(async(asset:Asset)=>asset),invalidateTicket:vi.fn()}));
vi.mock('./useLikesAlbum',()=>({useLikesAlbum:()=>({available:false,liked:new Set(),pending:new Set(),toggle:vi.fn()})}));
vi.mock('./AlbumMembershipEditor',()=>({AlbumMembershipEditor:()=>null}));
vi.mock('./ClassificationAssignmentEditor',()=>({ClassificationAssignmentEditor:()=>null}));
vi.mock('./ViewerInfo',()=>({ViewerInfo:()=>null}));
import {Viewer} from './Viewer';
const asset:Asset={id:'a',kind:'image',content_type:'image/png',preview:'https://test.invalid/thumb-a',creator_name:'A'};
beforeEach(()=>{localStorage.clear();mocks.native.mockReset();Object.defineProperty(window,'innerWidth',{configurable:true,value:800});Object.defineProperty(window,'innerHeight',{configurable:true,value:1280});});
afterEach(cleanup);

it('saves the shown original to the device and says where it went',async()=>{
  mocks.native.mockResolvedValue({folder:'pictures'});
  render(<Viewer items={[asset]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'원본 저장'}));
  expect(mocks.native).toHaveBeenCalledWith('assetSave',{assetId:'a',mime:'image/png'},expect.any(AbortSignal),expect.any(Number));
  expect((await screen.findByRole('status')).textContent).toContain('갤러리 › Lakomics에 저장했습니다');
});

it('hands the original to the share sheet and reports a failure in place',async()=>{
  mocks.native.mockRejectedValue(new Error('원본을 받지 못했습니다.'));
  render(<Viewer items={[asset]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'원본 공유'}));
  expect(mocks.native).toHaveBeenCalledWith('assetShare',{assetId:'a',mime:'image/png'},expect.any(AbortSignal),expect.any(Number));
  expect((await screen.findByRole('alert')).textContent).toBe('공유하지 못했습니다. 원본을 받지 못했습니다.');
});

it('allows one export at a time and cancels a running one when the viewer closes',async()=>{
  let signal!:AbortSignal;
  mocks.native.mockImplementation((_op:string,_payload:unknown,given:AbortSignal)=>{signal=given;return new Promise(()=>{});});
  const view=render(<Viewer items={[asset]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'원본 저장'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'원본 공유'}) as HTMLButtonElement).disabled).toBe(true));
  act(()=>view.unmount());
  expect(signal.aborted).toBe(true);
});

it('offers neither action for a pending capture or in the Private Vault',()=>{
  const {rerender}=render(<Viewer items={[{...asset,pending:true}]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
  expect(screen.queryByRole('button',{name:'원본 저장'})).toBeNull();
  rerender(<Viewer items={[asset]} index={0} onIndex={()=>{}} onClose={()=>{}} vault={{original:()=> 'https://vault.invalid/a',label:()=> '보관함'}}/>);
  expect(screen.queryByRole('button',{name:'원본 저장'})).toBeNull();
  expect(screen.queryByRole('button',{name:'원본 공유'})).toBeNull();
});
