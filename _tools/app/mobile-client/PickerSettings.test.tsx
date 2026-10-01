import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {PickerSettings} from './PickerSettings';
const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,errorText:String}));
afterEach(()=>{cleanup();vi.useRealTimers();});
it('shows the shared last-sync timestamp',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(2026,9,1,16));
  mocks.native.mockResolvedValue({supported:true,syncing:false,scanned:1,mediaCount:1,albumCount:1,ready:true,lastSyncedAt:new Date(2026,8,30,15,7,40).getTime(),error:''});
  render(<PickerSettings configured/>);
  expect((await screen.findByText('마지막 갱신 어제 15:07')).textContent).toBe('마지막 갱신 어제 15:07');
});
