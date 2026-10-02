import {act, cleanup, renderHook} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native}));
import {useExchangeThumbnail} from './useExchange';
afterEach(()=>{cleanup();mocks.native.mockReset();});

async function read(id:string){
  const hook=renderHook(()=>useExchangeThumbnail(id,true));
  await act(async()=>{});
  const url=hook.result.current;
  hook.unmount();
  return url;
}

it('evicts the least recently used thumbnail once 128 entries are retained',async()=>{
  mocks.native.mockImplementation(async(_op:string,{transferId}:{transferId:string})=>({url:`data:image/jpeg;base64,${transferId}`}));
  for(let i=0;i<128;i++)await read(`count-${i}`);
  const calls=mocks.native.mock.calls.length;
  await read('count-0');expect(mocks.native).toHaveBeenCalledTimes(calls);
  await read('count-128');
  await read('count-0');expect(mocks.native).toHaveBeenCalledTimes(calls+1);
  await read('count-1');expect(mocks.native).toHaveBeenCalledTimes(calls+2);
});

it('evicts by an 8 MiB string budget before reaching the count cap',async()=>{
  const url='data:image/jpeg;base64,'+'a'.repeat(1024*1024);
  mocks.native.mockResolvedValue({url});
  for(let i=0;i<5;i++)expect(await read(`bytes-${i}`)).toBe(url);
  const calls=mocks.native.mock.calls.length;
  await read('bytes-4');expect(mocks.native).toHaveBeenCalledTimes(calls);
  await read('bytes-0');expect(mocks.native).toHaveBeenCalledTimes(calls+1);
});

it('displays but does not retain a single thumbnail larger than the byte budget',async()=>{
  const url='data:image/jpeg;base64,'+'b'.repeat(4*1024*1024);
  mocks.native.mockResolvedValue({url});
  expect(await read('oversize')).toBe(url);
  const calls=mocks.native.mock.calls.length;
  expect(await read('oversize')).toBe(url);
  expect(mocks.native).toHaveBeenCalledTimes(calls+1);
});
