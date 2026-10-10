import {useMemo} from 'react';
import {cleanup, render} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {MangaWork, sharedVolume} from './CollectionWork';
import type {CollectionDetail, CollectionVolume} from './collectionModel';

vi.mock('./collectionArtwork', () => ({
  usePortraitUrl: () => ({url: null, failed: false}),
  useArtworkSet: () => useMemo(() => ({ready: true, urls: {}}), []),
}));
vi.mock('../src/collections/case/caseSounds', () => ({playCaseSound: vi.fn(), preloadCaseSounds: vi.fn()}));
afterEach(cleanup);

const base: CollectionVolume = {id: 'v1', volumeNumber: 1, editionIndex: 0, displayLabel: '1권'};
const details = {isbn13: '9780306406157', contents: 'Volume synopsis', price: 12000, publisher: 'Volume publisher', localReleaseDate: '2026-01-01'};
function show(volumes: CollectionVolume[]) {
  const shared = volumes.map(volume => sharedVolume(volume, '2026-10-10'));
  const item: CollectionDetail = {id: 'manga', name: 'Series', type: 'manga', showcase: false, volumes, artworks: []};
  return <MangaWork item={item} revision="r1" active privacy={false} volumes={shared} owned={null} latestKorean={null} onEnlarge={vi.fn()} info={null}/>;
}

it('preserves all per-volume print data through the tablet adapter', () => {
  const volume = sharedVolume({...base, ...details, releaseStatus: 'released'}, '2026-10-10');
  expect(volume).toMatchObject({...details, releaseStatus: 'released'});
  expect(sharedVolume(base, '2026-10-10')).toMatchObject({isbn13: null, localReleaseDate: null, releaseStatus: null});
  expect(sharedVolume({...base, localReleaseDate: '2999-01-01'}, '2026-10-10').releaseStatus).toBe('upcoming');
});

it('prints the selected volume with the same back component as PC and clears absent fields', () => {
  const {container, rerender} = render(show([{...base, ...details}]));
  const back = () => container.querySelector('.tablet-work > div[aria-hidden="false"] .manga-bb-back')!;
  expect(back().querySelector('.manga-back-synopsis')?.textContent).toBe('Volume synopsis');
  expect(back().querySelector('.manga-back-publisher')?.textContent).toContain('Volume publisher');
  expect(back().querySelector('.manga-back-code')?.textContent).toContain('ISBN 9780306406157');
  expect(back().querySelector('.manga-back-price')?.textContent).toBe('값 12,000원');
  expect(back().querySelector('svg')?.getAttribute('aria-label')).toBe('EAN-13 9780306406157');
  rerender(show([{...base, id: 'v2', volumeNumber: 2, localReleaseDate: '2026-02-02'}]));
  expect(back().querySelector('.manga-back-synopsis, .manga-back-code, .manga-back-price')).toBeNull();
  expect(back().querySelector('.manga-back-publisher')?.textContent).not.toContain('Volume publisher');
  // The shared fixed book and bottom band remain mounted with no metadata.
  expect(container.querySelector('.manga-bigbook')).not.toBeNull();
  expect(back().querySelector('.manga-back-bottom')).not.toBeNull();
});

it('keeps optional back content absent for an old replica', () => {
  const {container} = render(show([base]));
  expect(container.querySelector('.manga-back-synopsis, .manga-back-code, .manga-back-price')).toBeNull();
  expect(container.querySelector('.manga-back-volume')?.textContent).toBe('Series 1');
});
