import {act, cleanup, render} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {AlbumTileCard, wantsMedium} from './AlbumTileCard';
import type {TabletCardsApi} from './cardsClient';
import type {CardData} from '../../src/cards/types';

const fit = (changes: Partial<Parameters<typeof wantsMedium>[0]> = {}) =>
  ({cardWidth: 150, cardHeight: 210, artWidth: 2000, artHeight: 1400, pixelRatio: 2.375, ...changes});

it('asks for the medium copy only when the thumbnail would be visibly enlarged', () => {
  // Wide art in a portrait card is stretched by its height: 210 x 2.375 px over a 252 px thumbnail.
  expect(wantsMedium(fit())).toBe(true);
  expect(wantsMedium(fit({artWidth: 1400, artHeight: 2000}))).toBe(true);
  // A small cell at a low density is covered by the thumbnail.
  expect(wantsMedium(fit({cardWidth: 100, cardHeight: 140, pixelRatio: 1, artWidth: 1400, artHeight: 2000}))).toBe(false);
  // An original no larger than the thumbnail has nothing more to give; an unmeasured cell asks for nothing.
  expect(wantsMedium(fit({artWidth: 300, artHeight: 200}))).toBe(false);
  expect(wantsMedium(fit({cardWidth: 0, cardHeight: 0}))).toBe(false);
});

const card = (changes: Partial<CardData> = {}): CardData => ({
  id: 'c1:sr', characterId: 'c1', characterName: '루나', seriesName: '별자리', tier: 'sr', artAssetId: 'a1', artUrl: 'https://art.test/a1.webp',
  artWidth: 2000, artHeight: 1400, artMedium: true, count: 1, level: 1, ...changes,
});
const apiWith = (artMedium?: TabletCardsApi['artMedium']) => ({
  state: vi.fn(), open: vi.fn(), keep: vi.fn(), pack: vi.fn(), setTrashed: vi.fn(), album: vi.fn(), art: vi.fn(), cutout: vi.fn(), artMedium,
}) as TabletCardsApi;
const sources = (container: HTMLElement) => [...container.querySelectorAll('img.f-bg')].map(image => image.getAttribute('src'));
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()})));
  vi.stubGlobal('devicePixelRatio', 2.375);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({width: 150, height: 210} as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('starts on the thumbnail and loads the medium copy beside it, once', async () => {
  const artMedium = vi.fn(async () => 'https://r2.test/medium.webp');
  const api = apiWith(artMedium);
  const {container} = render(<AlbumTileCard card={card()} api={api}/>); await settle();
  expect(artMedium).toHaveBeenCalledTimes(1);
  expect(artMedium).toHaveBeenCalledWith('a1');
  // The thumbnail stays in its slot until the medium copy has decoded in the spare one.
  expect(sources(container)).toEqual(expect.arrayContaining(['https://art.test/a1.webp', 'https://r2.test/medium.webp']));
});

it('keeps the thumbnail when the cell does not need more, the server has no copy, or a cutout covers the picture', async () => {
  const artMedium = vi.fn(async () => 'https://r2.test/medium.webp');
  const {container, rerender} = render(<AlbumTileCard card={card({artMedium: false})} api={apiWith(artMedium)}/>); await settle();
  rerender(<AlbumTileCard card={card({tier: 'ur', cutoutUrl: 'https://cut.test/a1.png'})} api={apiWith(artMedium)}/>); await settle();
  expect(artMedium).not.toHaveBeenCalled();
  expect(sources(container)).not.toContain('https://r2.test/medium.webp');

  const failing = vi.fn(async () => '');
  const other = render(<AlbumTileCard card={card({id: 'c2:sr', artAssetId: 'a2'})} api={apiWith(failing)}/>); await settle();
  expect(failing).toHaveBeenCalledTimes(1);
  expect(sources(other.container)).toEqual(['https://art.test/a1.webp']);
});
