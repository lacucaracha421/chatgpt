import {act, cleanup, fireEvent, render, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Gallery} from './Gallery';
import type {Asset} from './types';

const mocks = vi.hoisted(() => ({loadThumbnail:vi.fn(), measure:vi.fn()}));
vi.mock('./media', () => ({loadThumbnail:mocks.loadThumbnail, invalidateTicket:vi.fn(), mediaTicket:vi.fn()}));
vi.mock('@tanstack/react-virtual', () => ({useVirtualizer:() => ({
  measure:mocks.measure, getTotalSize:() => 200,
  getVirtualItems:() => [{key:0,index:0,start:0}],
})}));

const asset:Asset = {id:'new-asset',kind:'image',thumbnail_available:false};
const preview = 'https://app.lakomics.local/media-cache/test';
const galleryProps = {density:1,identity:'recent',restoreScroll:0,onScroll:vi.fn(),onOpen:vi.fn(),onReady:vi.fn(),onNearEnd:vi.fn(),paused:false};
beforeEach(() => {
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
  mocks.loadThumbnail.mockReset();
  mocks.loadThumbnail.mockImplementation(async (item:Asset) => item.thumbnail_available === false ? item : {...item,preview});
});
afterEach(() => {cleanup();vi.unstubAllGlobals();});

// Home no longer shows asset images (HOME-DASH-001); the gallery is the surface that retries.
it('loads a newly available thumbnail for the same mounted gallery asset', async () => {
  const component = (item:Asset) => <Gallery {...galleryProps} items={[item]}/>;
  const view = render(component(asset));
  await act(async () => {});
  expect(view.container.querySelector('img')).toBeNull();
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(1);
  view.rerender(component({...asset,thumbnail_available:true}));
  await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe(preview));
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(2);
  // Unrelated metadata rerenders must not schedule an unbounded retry loop.
  view.rerender(component({...asset,thumbnail_available:true,creator_name:'Updated'}));
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(2);
});

it('keeps the painted thumbnail while a resume publication replaces its revision and decodes',async()=>{
  const component=(revision:string)=><Gallery {...galleryProps} items={[{...asset,thumbnail_available:true,thumbnail_revision:revision}]}/>;
  const view=render(component('one'));
  await waitFor(()=>expect(view.container.querySelector('img')?.getAttribute('src')).toBe(preview));
  const old=view.container.querySelector('img')!;
  await act(async()=>fireEvent.load(old));
  const nextUrl=preview+'-two';
  mocks.loadThumbnail.mockImplementation(async(item:Asset)=>({...item,preview:nextUrl}));
  view.rerender(component('two'));
  await waitFor(()=>expect(view.container.querySelector('[data-stable-image-loading]')?.getAttribute('src')).toBe(nextUrl));
  const next=view.container.querySelector<HTMLImageElement>('[data-stable-image-loading]')!;
  let decoded!:()=>void;
  const decoding=new Promise<void>(resolve=>{decoded=resolve;});
  Object.defineProperty(next,'decode',{value:()=>decoding});
  await act(async()=>fireEvent.load(next));
  expect(old.getAttribute('src')).toBe(preview);expect(old.style.visibility).toBe('');
  expect(next.style.visibility).toBe('hidden');
  await act(async()=>decoded());
  expect(next.style.visibility).toBe('');expect(old.style.visibility).toBe('hidden');
});
