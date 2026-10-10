import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useHomeUpcoming} from './homeDashboard';
import {resetHomeSourceCache} from './homeCache';
import {api} from './transport';

vi.mock('./transport',async importOriginal=>({...await importOriginal<typeof import('./transport')>(),api:vi.fn()}));
afterEach(()=>{cleanup();resetHomeSourceCache();localStorage.clear();vi.clearAllMocks();});

it('conditionally reads upcoming and reuses a fresh Home source on return',async()=>{
  vi.mocked(api).mockResolvedValue({version:1,revision:1,entries:[],wishlist:[],pending:[]});
  const view=renderHook(({enabled})=>useHomeUpcoming(enabled,'conditional-fixture'),{initialProps:{enabled:true}});
  await act(async()=>{});
  expect(vi.mocked(api)).toHaveBeenCalledWith('/v1/home/upcoming',expect.any(AbortSignal),undefined,'GET',true);
  view.rerender({enabled:false});view.rerender({enabled:true});await act(async()=>{});
  expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
});
