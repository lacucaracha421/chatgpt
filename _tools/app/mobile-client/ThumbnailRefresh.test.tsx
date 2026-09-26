import {act, cleanup, render, waitFor} from '@testing-library/react';
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
