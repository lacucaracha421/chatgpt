import {act, cleanup, render} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Asset} from './types';
const mocks = vi.hoisted(() => ({loadThumbnail:vi.fn()}));
vi.mock('./media',() => ({loadThumbnail:mocks.loadThumbnail}));
import {Cover} from './CoverGroup';

const asset:Asset = {id:'cover',kind:'image'};
const advance = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const image = () => document.querySelector('.home-cover img');
// A failed thumbnail resolves without a preview (prepareAssets swallows the error).
const failed = async (item:Asset) => ({...item,ratio:1});
const ready = async (item:Asset) => ({...item,preview:`https://example.invalid/${item.id}`});
beforeEach(() => { vi.useFakeTimers(); mocks.loadThumbnail.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows a cover that failed once without a pause or asset change', async () => {
  mocks.loadThumbnail.mockImplementationOnce(failed).mockImplementation(ready);
  render(<Cover asset={asset} paused={false}/>); await advance();
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(1); expect(image()).toBeNull();
  await advance(1000);
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(2);
  expect(image()?.getAttribute('src')).toBe('https://example.invalid/cover');
  await advance(60_000); expect(mocks.loadThumbnail).toHaveBeenCalledTimes(2);
});

it('bounds the retries, then waits until the cover is paused and resumed', async () => {
  mocks.loadThumbnail.mockImplementation(failed);
  const view = render(<Cover asset={asset} paused={false}/>); await advance();
  for (let second = 0; second < 60; second++) await advance(1000);
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(4);
  await advance(30 * 60_000); expect(mocks.loadThumbnail).toHaveBeenCalledTimes(4);
  view.rerender(<Cover asset={asset} paused/>); view.rerender(<Cover asset={asset} paused={false}/>); await advance();
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(5);
});

it('never retries assets that have no thumbnail, and cancels a pending retry on pause or unmount', async () => {
  mocks.loadThumbnail.mockImplementation(failed);
  render(<Cover asset={{...asset,id:'none',thumbnail_available:false}} paused={false}/>);
  render(<Cover asset={{...asset,id:'pending',pending:true}} paused={false}/>);
  await advance(60_000); expect(mocks.loadThumbnail).toHaveBeenCalledTimes(2);
  cleanup(); mocks.loadThumbnail.mockClear();
  const view = render(<Cover asset={asset} paused={false}/>); await advance();
  view.rerender(<Cover asset={asset} paused/>); await advance(60_000);
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(1);
  view.rerender(<Cover asset={asset} paused={false}/>); await advance();
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(2);
  view.unmount(); await advance(60_000);
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(2);
});
