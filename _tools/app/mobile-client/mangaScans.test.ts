import {expect, it, vi} from 'vitest';
import {artworkTicket} from './collectionArtwork';
import {mangaScanRequests, mangaScanVolumes} from './mangaScans';
import {native} from './transport';
import type {CollectionSummary, CollectionVolume} from './collectionModel';

vi.mock('./transport', () => ({native: vi.fn()}));

it('requests scans with the published digest through the cover media cache and projects decoded URLs', async () => {
  const digest = 'a'.repeat(64), id = `manga-scan-9780306406157-side-${digest}`;
  const volume: CollectionVolume = {id: 'v', volumeNumber: 1, editionIndex: 0, displayLabel: '1', spineScan: {side: id, back: null}};
  const item: CollectionSummary = {id: 'work', type: 'manga', name: 'Book', showcase: false, artworkVersions: {[id]: {thumbnail: digest}}};
  const url = 'https://appassets.androidplatform.net/local-media/scan';
  vi.mocked(native).mockResolvedValue({url, expires_in: 240});
  const requests = mangaScanRequests([volume, volume]);
  expect(Object.keys(requests)).toEqual([id]);
  const controller = new AbortController();
  const ticket = await artworkTicket(item, requests[id].id, 'revision', false, controller.signal);
  expect(native).toHaveBeenCalledWith('collectionArtwork', {collectionId: 'work', artworkId: id, variant: 'thumbnail', revision: 'revision', digest}, controller.signal);
  expect(mangaScanVolumes([volume], {[id]: ticket.url})[0].spineScan).toEqual({side: url, back: null});
  expect(mangaScanVolumes([volume], {})[0].spineScan).toEqual({side: null, back: null});
});
