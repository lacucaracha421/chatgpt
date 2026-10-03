import {afterEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({prepareAssets:vi.fn(),decodeImage:vi.fn()}));
vi.mock('./media',()=>mocks);
import {readyFirstScreen} from './firstScreen';
afterEach(()=>{localStorage.clear();vi.unstubAllGlobals();mocks.prepareAssets.mockReset();mocks.decodeImage.mockReset();});
it.each(['filter','abort'] as const)('rechecks %s before decoding results held by the batch',async change=>{
 vi.stubGlobal('LakomicsNative',{});
 const batch=Promise.withResolvers<Asset[]>();mocks.prepareAssets.mockReturnValue(batch.promise);mocks.decodeImage.mockResolvedValue(undefined);
 const items:Asset[]=[{id:'explicit',kind:'image',contentRating:'e'},{id:'safe',kind:'image',contentRating:'g'}];
 const controller=new AbortController();
 const work=readyFirstScreen(items,controller.signal);
 expect(mocks.prepareAssets).toHaveBeenCalledWith(items,controller.signal);
 if(change==='filter')localStorage.setItem('lakomics.mobile.nsfwFilter','1');else controller.abort();
 batch.resolve(items.map(asset=>({...asset,preview:`https://test.invalid/${asset.id}`})));
 const prepared=await work;
 if(change==='filter'){
  expect(mocks.decodeImage).toHaveBeenCalledExactlyOnceWith('https://test.invalid/safe',controller.signal);
  expect(prepared[0].preview).toBeUndefined();expect(prepared[1].preview).toContain('/safe');
 }else {expect(mocks.decodeImage).not.toHaveBeenCalled();expect(prepared).toBe(items);}
});
it('uses the caller signal to cancel a first-screen decode already in progress',async()=>{
 vi.stubGlobal('LakomicsNative',{});
 const asset:Asset={id:'safe',kind:'image',contentRating:'g'};
 mocks.prepareAssets.mockResolvedValue([{...asset,preview:'https://test.invalid/safe'}]);
 const controller=new AbortController();
 mocks.decodeImage.mockImplementation((_url:string,signal:AbortSignal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true})));
 const work=readyFirstScreen([asset],controller.signal);
 await vi.waitFor(()=>expect(mocks.decodeImage).toHaveBeenCalledOnce());
 controller.abort();expect(await work).toEqual([asset]);
});
