import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), native: mocks.native}));
import {artworkSource, artworkTicket} from './collectionArtwork';
import {artworkSize, artworkVariant, type CollectionSummary} from './collectionModel';

const zelda: CollectionSummary = {id: 'b8845f02', type: 'game', name: 'The Legend of Zelda', showcase: false, selectedWorkArtworkId: 'cover',
  artworkVersions: {cover: {thumbnail: null, original: 'o'.repeat(64)}, made: {thumbnail: 't'.repeat(64), original: 'p'.repeat(64)}}};
beforeEach(() => { mocks.native.mockReset(); mocks.native.mockResolvedValue({url: 'https://example.invalid/a', expires_in: 300}); });
afterEach(() => vi.restoreAllMocks());

it('serves a thumbnail-less artwork from its original and keeps thumbnails otherwise', () => {
  expect(artworkVariant(zelda, 'cover')).toBe('original');
  expect(artworkVariant(zelda, 'made')).toBe('thumbnail');
  expect(artworkVariant(zelda, 'made', true)).toBe('original');
  // An older server publishes no digests: the shelf keeps asking for thumbnails.
  expect(artworkVariant({...zelda, artworkVersions: undefined}, 'cover')).toBe('thumbnail');
  expect(artworkSource(zelda, 'cover', 'r', false)).toBe(artworkSource(zelda, 'cover', 'r', true));
});

it('asks native for the original of a shelf cover with no thumbnail', async () => {
  await artworkTicket(zelda, 'cover', 'r1', false, new AbortController().signal);
  expect(mocks.native).toHaveBeenCalledWith('collectionArtwork', {collectionId: zelda.id, artworkId: 'cover', variant: 'original', revision: 'r1', digest: 'o'.repeat(64)}, expect.anything());
  await artworkTicket(zelda, 'made', 'r1', false, new AbortController().signal);
  expect(mocks.native).toHaveBeenLastCalledWith('collectionArtwork', {collectionId: zelda.id, artworkId: 'made', variant: 'thumbnail', revision: 'r1', digest: 't'.repeat(64)}, expect.anything());
});

it('asks for the medium copy only where the publication names one', async () => {
  const withMedium: CollectionSummary = {...zelda, spineArtworkId: 'spine', artworkVersions: {...zelda.artworkVersions, spine: {thumbnail: 't'.repeat(64), original: 'p'.repeat(64), medium: 'm'.repeat(64)}}};
  expect(artworkSize(withMedium, 'spine', false, true)).toBe('medium');
  expect(artworkSize(withMedium, 'spine', false, false)).toBe('thumbnail');
  expect(artworkSize(withMedium, 'spine', true, true)).toBe('original');
  expect(artworkSize(withMedium, 'made', false, true)).toBe('thumbnail');
  expect(artworkSource(withMedium, 'spine', 'r', false, true)).not.toBe(artworkSource(withMedium, 'spine', 'r', false));
  await artworkTicket(withMedium, 'spine', 'r1', false, new AbortController().signal, true);
  expect(mocks.native).toHaveBeenLastCalledWith('collectionArtwork', {collectionId: zelda.id, artworkId: 'spine', variant: 'medium', revision: 'r1', digest: 'm'.repeat(64)}, expect.anything());
});
