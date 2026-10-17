import {act,renderHook,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:vi.fn(),errorText:(reason:unknown)=>reason instanceof Error?reason.message:String(reason)}));
import {useTabletFolderPins} from './useTabletFolderPins';

beforeEach(()=>mocks.api.mockReset());

it('shows a pin at once, and puts it back with the reason when the server refuses',async()=>{
  let refuse=false;
  mocks.api.mockImplementation(async(_path:string,_signal?:unknown,body?:unknown)=>{
    if(!body)return{version:1,revision:1,pinnedIds:['a']};
    if(refuse)throw new Error('서버에 연결하지 못했습니다.');
    return{version:1,revision:2,pinnedIds:['a','b']};
  });
  const {result}=renderHook(()=>useTabletFolderPins(true,'scope'));
  await waitFor(()=>expect(result.current.ids).toEqual(['a']));
  let failure='';
  await act(async()=>{failure=await result.current.toggle('b');});
  expect(failure).toBe('');
  expect(result.current.ids).toEqual(['a','b']);
  refuse=true;
  await act(async()=>{failure=await result.current.toggle('b');});
  expect(failure).toBe('서버에 연결하지 못했습니다.');
  expect(result.current.ids).toEqual(['a','b']);
});
