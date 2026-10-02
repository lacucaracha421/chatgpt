import {act,renderHook,waitFor,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({...mocks,errorText:(error:Error)=>error.message}));
import {useLikesAlbum} from './useLikesAlbum';
const scope={libraryId:'a'.repeat(32),epoch:1};
let liked=false;
beforeEach(()=>{
  mocks.api.mockReset();mocks.native.mockReset();liked=false;
  mocks.native.mockResolvedValue({...scope,adopted:true,albums:[]});
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>{
    if(path.startsWith('/v1/albums/likes'))return {albumId:'renamed-likes',memberships:[{assetId:'one',desiredState:liked,entityRevision:liked?1:0}]};
    if(body?.commandType==='ensureLikesAlbum')return {album:{id:'renamed-likes'}};
    if(body?.commandType==='setAlbumMembership'){liked=body.desiredState as boolean;return {membership:{desiredState:liked}};}
  });
});
afterEach(cleanup);
it('reads membership and uses the designated id for add and remove',async()=>{
  const {result}=renderHook(()=>useLikesAlbum(['one'],true,1));
  await waitFor(()=>expect(result.current.available).toBe(true));
  expect(result.current.liked.has('one')).toBe(false);
  await act(()=>result.current.toggle('one'));
  expect(result.current.liked.has('one')).toBe(true);
  expect(mocks.api).toHaveBeenCalledWith('/v1/albums/commands',undefined,expect.objectContaining({...scope,commandType:'setAlbumMembership',albumId:'renamed-likes',assetId:'one',desiredState:true,expectedRevision:0}),'PUT');
  await act(()=>result.current.toggle('one'));
  expect(result.current.liked.has('one')).toBe(false);
  expect(mocks.api).toHaveBeenCalledWith('/v1/albums/commands',undefined,expect.objectContaining({commandType:'setAlbumMembership',desiredState:false,expectedRevision:1}),'PUT');
});
it('ensures the album on first heart use and hides hearts without supported authority',async()=>{
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>path.startsWith('/v1/albums/likes')?{albumId:body?null:'renamed-likes',memberships:[{assetId:'one',desiredState:false,entityRevision:0}]}:{album:{id:'renamed-likes'}});
  const {result,rerender}=renderHook(({enabled})=>useLikesAlbum(['one'],enabled,1),{initialProps:{enabled:true}});
  await waitFor(()=>expect(result.current.available).toBe(true));
  await act(()=>result.current.toggle('one'));
  expect(mocks.api).toHaveBeenCalledWith('/v1/albums/commands',undefined,expect.objectContaining({commandType:'ensureLikesAlbum',albumId:expect.any(String)}),'PUT');
  rerender({enabled:false});expect(result.current.available).toBe(false);
});
it('reports a command failure without filling the heart',async()=>{
  const {result}=renderHook(()=>useLikesAlbum(['one'],true,1));
  await waitFor(()=>expect(result.current.available).toBe(true));
  mocks.api.mockRejectedValue(new Error('동기화 충돌'));
  await act(()=>result.current.toggle('one'));
  expect(result.current.error).toBe('동기화 충돌');expect(result.current.liked.has('one')).toBe(false);
});
it('hides hearts when the server does not support likes reads',async()=>{
  mocks.api.mockRejectedValue(new Error('unsupported'));
  const {result}=renderHook(()=>useLikesAlbum(['one'],true,1));
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(result.current.available).toBe(false);
});

it.each([false,true])('uses the shown heart %s even when the server changed before the click',async(shown)=>{
  liked=shown;
  const {result}=renderHook(()=>useLikesAlbum(['one'],true,1));
  await waitFor(()=>expect(result.current.available).toBe(true));
  liked=!shown;
  await act(()=>result.current.toggle('one'));
  expect(mocks.api).toHaveBeenCalledWith('/v1/albums/commands',undefined,expect.objectContaining({commandType:'setAlbumMembership',desiredState:!shown,expectedRevision:shown?0:1}),'PUT');
  expect(result.current.liked.has('one')).toBe(!shown);
});
