import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {MutableRefObject} from 'react';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(reason:Error)=>reason.message}));
vi.mock('./Viewer',()=>({Viewer:({items,index,onClose,onArtist}:{items:Asset[];index:number;onClose():void;onArtist?(artist:unknown):void})=><div><span>{`asset:${items[index].id}`}</span><button onClick={onClose}>원본 닫기</button><button onClick={()=>onArtist?.({id:'artist',label:'작가'})}>정보의 작가</button></div>}));
vi.mock('./Artists',()=>({Artists:({initialArtist,onClose,backRef}:{initialArtist:{id:string};onClose():void;backRef:MutableRefObject<(()=>boolean)|null>})=>{backRef.current=()=>{onClose();return true;};return <div><span>{`artist:${initialArtist.id}`}</span><button onClick={onClose}>작가 닫기</button></div>;}}));
vi.mock('./CharacterBrowser',()=>({CharacterBrowser:({initialNode,onExit,backRef}:{initialNode:string;onExit():void;backRef:MutableRefObject<(()=>boolean)|null>})=>{backRef.current=()=>false;return <div><span>{`character:${initialNode}`}</span><button onClick={onExit}>폴더 닫기</button></div>;}}));
import {findLinkedAsset,LinkedLibraryDestination} from './LinkedLibraryDestination';
beforeEach(()=>{mocks.api.mockReset();});
afterEach(cleanup);
it('finds an original outside the loaded page through the existing cursor listing',async()=>{
  mocks.api.mockResolvedValueOnce({items:[{id:'other'}],has_more:true,next_cursor:'next'}).mockResolvedValueOnce({items:[{id:'original',kind:'video'}],has_more:false,next_cursor:null});
  expect(await findLinkedAsset('original',[],new AbortController().signal)).toMatchObject({id:'original',kind:'video'});
  expect(mocks.api.mock.calls[1][0]).toContain('cursor=next');
});
it('returns a loaded Asset without scanning and reports an unavailable original',async()=>{
  const asset={id:'known',kind:'image'};
  expect(await findLinkedAsset('known',[asset],new AbortController().signal)).toBe(asset);expect(mocks.api).not.toHaveBeenCalled();
  mocks.api.mockResolvedValue({items:[],has_more:false,next_cursor:null});
  await expect(findLinkedAsset('gone',[],new AbortController().signal)).rejects.toThrow('원본 에셋');
});
it('keeps the original when visiting its artist, and Back closes only the new destination',async()=>{
  const close=vi.fn();render(<LinkedLibraryDestination target={{kind:'asset',id:'a'}} knownAssets={[{id:'a',kind:'image'}]} classifications={[]} endpoint="test" onClose={close}/>);
  await screen.findByText('asset:a');fireEvent.click(screen.getByRole('button',{name:'정보의 작가'}));
  await screen.findByText('artist:artist');
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  expect(close).not.toHaveBeenCalled();expect(screen.getByText('asset:a')).toBeTruthy();
  act(()=>window.dispatchEvent(new Event('lakomics-back')));expect(close).toHaveBeenCalledOnce();
});
it('resolves a card character source id to the published node, then returns on Back',async()=>{
  mocks.api.mockResolvedValue({nodes:[{id:'character:c',sourceId:'c',kind:'character'}]});
  const close=vi.fn();render(<LinkedLibraryDestination target={{kind:'character',id:'c'}} knownAssets={[]} classifications={[]} endpoint="test" onClose={close}/>);
  await screen.findByText('character:character:c');
  act(()=>window.dispatchEvent(new Event('lakomics-back')));expect(close).toHaveBeenCalledOnce();
});
it('cancels a metadata search when Back leaves the pending destination',async()=>{
  let signal!:AbortSignal;mocks.api.mockImplementation((_path:string,value:AbortSignal)=>{signal=value;return new Promise(()=>{});});
  const view=render(<LinkedLibraryDestination target={{kind:'asset',id:'a'}} knownAssets={[]} classifications={[]} endpoint="test" onClose={vi.fn()}/>);
  await waitFor(()=>expect(signal).toBeDefined());view.unmount();expect(signal.aborted).toBe(true);
});
