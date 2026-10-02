import {fireEvent, cleanup, render, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
const mocks = vi.hoisted(() => ({native: vi.fn()}));
vi.mock('./transport', () => ({native: mocks.native}));
import {ShelfTile, workCaseData} from './CollectionShelf';

const item: CollectionSummary = {id: 'manga', name: '만화 제목', author: '작가 이름', type: 'manga', showcase: false,
  selectedWorkArtworkId: 'first', volumes: [
    {id: 'v1', volumeNumber: 1, editionIndex: 0, displayLabel: '1', coverArtworkId: 'first', coverFocusX: .25},
    {id: 'v2', volumeNumber: 2, editionIndex: 0, displayLabel: '2', coverArtworkId: 'second', coverFocusX: .75},
  ]};
afterEach(() => {cleanup(); vi.clearAllMocks();});

it('uses only the matching front cover volume for focus and the optional 1 marker', () => {
  expect(workCaseData(item, {front: '/front'}, false)).toMatchObject({author: item.author, coverFocus: .25, volumeNumber: 1, front: '/front'});
  expect(workCaseData({...item, selectedWorkArtworkId: 'second'}, {front: '/front'}, false)).toMatchObject({coverFocus: .75, volumeNumber: null});
  expect(workCaseData({...item, selectedWorkArtworkId: 'custom'}, {front: '/front'}, false)).toMatchObject({coverFocus: null, volumeNumber: null});
  expect(workCaseData({...item, selectedWorkArtworkId: null}, {front: '/front'}, false)).toMatchObject({coverFocus: .25, volumeNumber: 1});
  expect(workCaseData({...item, selectedWorkArtworkId: null, volumes: undefined}, {front: '/front'}, false)).toMatchObject({coverFocus: null, volumeNumber: null});
});

it('draws title, the same front source and author without requesting a separate manga spine', async () => {
  mocks.native.mockResolvedValue({url: 'https://example.invalid/cover'});
  const {container} = render(<ShelfTile item={{...item, spineArtworkId: 'unused'}} revision="r1" active privacy={false} picked={false} onTap={() => undefined}/>);
  await waitFor(() => expect(container.querySelector('.cs-front img')).not.toBeNull());
  expect(container.querySelector('.manga-jspine-title')?.textContent).toBe(item.name);
  expect(container.querySelector('.manga-jspine-author')?.textContent).toBe(item.author);
  // The shared case mounts the spine after the front has had a paint opportunity.
  fireEvent.load(container.querySelector('.cs-front img')!);
  await waitFor(() => expect(container.querySelector('.cs-spine img')?.getAttribute('src')).toBe(container.querySelector('.cs-front img')?.getAttribute('src')));
  expect(container.querySelector('.manga-jspine-number')?.textContent).toBe('1');
  expect(mocks.native).toHaveBeenCalledTimes(1);
  expect(mocks.native).toHaveBeenCalledWith('collectionArtwork', expect.objectContaining({artworkId: 'first'}), expect.any(AbortSignal));
});
