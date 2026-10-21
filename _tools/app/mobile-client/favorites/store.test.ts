import {beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('../transport',()=>({api:mocks.api,native:vi.fn(),errorText:(reason:unknown)=>reason instanceof Error?reason.message:String(reason)}));
import {changeFavorites,loadFavorites} from './store';
import {useFavorites} from './useFavorites';
import type {FavoriteCharacters,FavoriteCommand} from '../../src/library/types';

const document=(revision:number):FavoriteCharacters=>({version:1,revision,entries:[{characterId:'sera',coverAssetId:null,coverY:50,profile:{memo:'PC 메모'},workIds:['work'],extraWorks:[]}]});
beforeEach(()=>mocks.api.mockReset());
afterEach(cleanup);

it('reads the shared document and sends one batch without replacing the document',async()=>{
  mocks.api.mockResolvedValue(document(3));
  expect(await loadFavorites()).toEqual(document(3));
  const commands:FavoriteCommand[]=[{op:'add',ids:['a','b']},{op:'order',ids:['b','sera','a']},{op:'update',id:'sera',set:{coverAssetId:'art',coverY:72}},{op:'remove',ids:['a']}];
  expect(await changeFavorites(commands)).toEqual(document(3));
  expect(mocks.api.mock.calls).toEqual([
    ['/v1/library/favorite-characters',undefined],
    ['/v1/library/favorite-characters',undefined,{commands},'POST'],
  ]);
});

it('keeps the confirmed characters and profile on a refused edit, then allows a retry',async()=>{
  mocks.api.mockResolvedValueOnce(document(3)).mockRejectedValueOnce(new Error('연결 끊김')).mockResolvedValueOnce(document(4));
  const {result}=renderHook(()=>useFavorites(true));
  await waitFor(()=>expect(result.current.document?.revision).toBe(3));
  await act(async()=>{expect(await result.current.change({op:'remove',ids:['sera']})).toBe(false);});
  expect(result.current.document).toEqual(document(3));
  expect(result.current.error).toBe('연결 끊김');
  await act(async()=>{expect(await result.current.change({op:'update',id:'sera',set:{coverY:72}})).toBe(true);});
  expect(result.current.document).toEqual(document(4));
});

it('ignores an older read that finishes after a saved cover and refreshes on the status signal',async()=>{
  let finishRead!:(reply:FavoriteCharacters)=>void;
  mocks.api.mockResolvedValueOnce(document(1)).mockImplementationOnce(()=>new Promise(resolve=>{finishRead=resolve;})).mockResolvedValueOnce(document(3)).mockResolvedValue(document(4));
  const {result}=renderHook(()=>useFavorites(true));
  await waitFor(()=>expect(result.current.document?.revision).toBe(1));
  act(()=>{result.current.refresh();});
  await act(async()=>{await result.current.change({op:'update',id:'sera',set:{coverY:72}});});
  await act(async()=>{finishRead(document(2));});
  expect(result.current.document?.revision).toBe(3);
  act(()=>window.dispatchEvent(new CustomEvent('lakomics-sync-signals',{detail:{live:true,signals:{favoriteCharacters:3}}})));
  act(()=>window.dispatchEvent(new CustomEvent('lakomics-sync-signals',{detail:{live:true,signals:{favoriteCharacters:4}}})));
  await waitFor(()=>expect(result.current.document?.revision).toBe(4));
});
