import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Gallery} from './Gallery';
import {Home, type HomeProps} from './Home';
import type {Asset} from './types';

const mocks = vi.hoisted(() => ({loadThumbnail:vi.fn(), measure:vi.fn()}));
vi.mock('./media', () => ({loadThumbnail:mocks.loadThumbnail, invalidateTicket:vi.fn(), mediaTicket:vi.fn()}));
vi.mock('./transport', () => ({api:vi.fn()}));
vi.mock('@tanstack/react-virtual', () => ({useVirtualizer:() => ({
  measure:mocks.measure, getTotalSize:() => 200,
  getVirtualItems:() => [{key:0,index:0,start:0}],
})}));

const asset:Asset = {id:'new-asset',kind:'image',thumbnail_available:false};
const preview = 'https://app.lakomics.local/media-cache/test';
const galleryProps = {density:1,identity:'recent',restoreScroll:0,onScroll:vi.fn(),onOpen:vi.fn(),onReady:vi.fn(),onNearEnd:vi.fn(),paused:false};
const homeProps:Omit<HomeProps,'items'> = {classifications:[],recentFolders:[],revisit:{bundles:[]},captures:[],busy:false,paused:false,secondaryError:'',revision:1,onSelect:vi.fn(),onOpen:vi.fn(),onPending:vi.fn()};
beforeEach(() => {
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
  mocks.loadThumbnail.mockReset();
  mocks.loadThumbnail.mockImplementation(async (item:Asset) => item.thumbnail_available === false ? item : {...item,preview});
});
afterEach(() => {cleanup();vi.unstubAllGlobals();});

it.each(['gallery','home'] as const)('loads a newly available thumbnail for the same mounted %s asset', async surface => {
  const component = (item:Asset) => surface === 'gallery'
    ? <Gallery {...galleryProps} items={[item]}/>
    : <Home {...homeProps} items={[item]}/>;
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

it('does not load a newly available thumbnail while Home is paused', async () => {
  const view = render(<Home {...homeProps} paused items={[asset]}/>);
  view.rerender(<Home {...homeProps} paused items={[{...asset,thumbnail_available:true}]}/>);
  expect(mocks.loadThumbnail).not.toHaveBeenCalled();
  view.rerender(<Home {...homeProps} items={[{...asset,thumbnail_available:true}]}/>);
  await waitFor(() => expect(screen.getByRole('region',{name:'최근 저장'}).querySelector('img')).not.toBeNull());
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(1);
});
