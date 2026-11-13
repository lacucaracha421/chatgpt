import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {releaseRows, useHomeUpcoming} from './homeDashboard';
import type {CollectionSummary} from './collectionModel';
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

it('excludes unwatched and unknown works from Home even when a cached count includes them',()=>{
  const work: CollectionSummary = {id:'watched',name:'Watched',type:'manga',showcase:false,releaseWatch:{enabled:true,available:true}};
  const shelf={ready:true,revision:'r1',works:[work,{...work,id:'passive',releaseWatch:{enabled:false,available:true}},{...work,id:'game',type:'game' as const}]};
  const rows=releaseRows(shelf,{unread:10,byCollection:{watched:2,passive:3,unknown:4,game:1}});
  expect(rows.map(row=>[row.id,row.unread])).toEqual([['watched',2]]);
});
