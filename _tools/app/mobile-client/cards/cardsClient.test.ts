import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({api: vi.fn(), ticket: vi.fn()}));
vi.mock('../transport', async () => ({...await vi.importActual<typeof import('../transport')>('../transport'), api: mocks.api}));
vi.mock('../media', () => ({mediaTicket: mocks.ticket}));
vi.mock('../../src/shared/motion/viewportImages', () => ({preloadImages: vi.fn(async () => undefined)}));
import {
  ALBUM_PAGE_SIZE, artUrl, cutoutUrl, displayCards, displayCover, finishOperation, isUndecided, operationId, readResult, saveResult, tabletCardsApi,
  type CardState, type OpenResult, type ServerCard, type TabletCardsApi,
} from './cardsClient';

const serverCard = (changes: Partial<ServerCard> = {}): ServerCard => ({
  slot: 0, characterId: 'c1', characterName: '루나', seriesName: '별자리', tier: 'sr', artAssetId: 'a1', artWidth: 1000, artHeight: 1400,
  cutout: null, count: 1, level: 1, serial: null, isNew: true, ...changes,
});
const fakeApi = (changes: Partial<TabletCardsApi> = {}): TabletCardsApi => ({
  state: vi.fn(), open: vi.fn(), keep: vi.fn(), pack: vi.fn(), album: vi.fn(), setTrashed: vi.fn(),
  art: vi.fn(async id => `https://art.test/${id}.webp`), cutout: vi.fn(async id => `https://cut.test/${id}.png`), ...changes,
});

beforeEach(() => { mocks.api.mockReset(); mocks.ticket.mockReset(); localStorage.clear(); });
afterEach(() => vi.restoreAllMocks());

describe('routes', () => {
  it('reads the state and one pack with GET, keeping ids as one encoded segment', async () => {
    mocks.api.mockResolvedValue({ok: true});
    const signal = new AbortController().signal;
    await tabletCardsApi.state(signal);
    expect(mocks.api).toHaveBeenLastCalledWith('/v1/cards/state', signal);
    await tabletCardsApi.pack('d-20261015');
    expect(mocks.api).toHaveBeenLastCalledWith('/v1/cards/packs/d-20261015');
    await tabletCardsApi.pack('d-2026/../x');
    expect(mocks.api).toHaveBeenLastCalledWith('/v1/cards/packs/d-2026%2F..%2Fx');
  });

  it('sends the retry key with open, and the key and slots with keep, as POST bodies', async () => {
    mocks.api.mockResolvedValue({ok: true});
    await tabletCardsApi.open('d-20261015', 'op-1');
    expect(mocks.api).toHaveBeenLastCalledWith('/v1/cards/packs/d-20261015/open', undefined, {operationId: 'op-1'}, 'POST');
    await tabletCardsApi.keep('b-20261015', 'op-2', [0, 3]);
    expect(mocks.api).toHaveBeenLastCalledWith('/v1/cards/packs/b-20261015/keep', undefined, {operationId: 'op-2', slots: [0, 3]}, 'POST');
  });

  it('pages the album with the cursor and the page size, and omits an empty cursor', async () => {
    mocks.api.mockResolvedValue({cards: []});
    await tabletCardsApi.album(null);
    expect(mocks.api.mock.calls.at(-1)![0]).toBe(`/v1/cards/album?limit=${ALBUM_PAGE_SIZE}`);
    const signal = new AbortController().signal;
    await tabletCardsApi.album('abc_-', signal);
    expect(mocks.api).toHaveBeenLastCalledWith(`/v1/cards/album?after=abc_-&limit=${ALBUM_PAGE_SIZE}`, signal);
  });

  it('lists trash separately and posts trash or restore for the selected character and tier', async () => {
    mocks.api.mockResolvedValue({cards: []});
    await tabletCardsApi.album(null, undefined, true);
    expect(mocks.api).toHaveBeenLastCalledWith(`/v1/cards/album?limit=${ALBUM_PAGE_SIZE}&trashed=true`, undefined);
    await tabletCardsApi.setTrashed('c1', 'sr', true);
    expect(mocks.api).toHaveBeenLastCalledWith('/v1/cards/album/c1/sr/trash', undefined, undefined, 'POST');
    await tabletCardsApi.setTrashed('c1', 'sr', false);
    expect(mocks.api).toHaveBeenLastCalledWith('/v1/cards/album/c1/sr/restore', undefined, undefined, 'POST');
  });

  it('asks for a cutout ticket with POST and accepts only an https URL', async () => {
    mocks.api.mockResolvedValueOnce({url: 'https://r2.test/cut.png?sig=1', expires_in: 300});
    expect(await tabletCardsApi.cutout('asset_1')).toBe('https://r2.test/cut.png?sig=1');
    expect(mocks.api).toHaveBeenLastCalledWith('/v1/cards/cutouts/asset_1/ticket', undefined, undefined, 'POST');
    mocks.api.mockResolvedValueOnce({url: 'http://insecure.test/x'});
    expect(await tabletCardsApi.cutout('asset_2')).toBe('');
    mocks.api.mockResolvedValueOnce({});
    expect(await tabletCardsApi.cutout('asset_3')).toBe('');
  });

  it('propagates server errors so a failed tear can be retried', async () => {
    mocks.api.mockRejectedValue(Object.assign(new Error('서버 오류'), {status: 503}));
    await expect(tabletCardsApi.open('d-20261015', 'op')).rejects.toThrow('서버 오류');
    await expect(tabletCardsApi.keep('d-20261015', 'op', [1])).rejects.toThrow('서버 오류');
  });
});

describe('art', () => {
  it('uses the thumbnail ticket and falls back to the original when the thumbnail is unavailable', async () => {
    mocks.ticket.mockResolvedValueOnce({url: 'https://local/thumb.webp'});
    expect(await tabletCardsApi.art('a1')).toBe('https://local/thumb.webp');
    expect(mocks.ticket).toHaveBeenLastCalledWith(expect.objectContaining({id: 'a1', kind: 'image'}), 'thumbnail');
    mocks.ticket.mockRejectedValueOnce(new Error('409')).mockResolvedValueOnce({url: 'https://local/original.jpg'});
    expect(await tabletCardsApi.art('a2')).toBe('https://local/original.jpg');
    expect(mocks.ticket).toHaveBeenLastCalledWith(expect.objectContaining({id: 'a2'}), 'original');
  });

  it('caches tickets per api and never keeps a failure', async () => {
    const api = fakeApi();
    await Promise.all([artUrl(api, 'a1'), artUrl(api, 'a1')]);
    await artUrl(api, 'a1');
    expect(api.art).toHaveBeenCalledTimes(1);
    vi.mocked(api.cutout).mockRejectedValueOnce(new Error('404'));
    expect(await cutoutUrl(api, 'a1')).toBe('');
    expect(await cutoutUrl(api, 'a1')).toBe('https://cut.test/a1.png');
    expect(api.cutout).toHaveBeenCalledTimes(2);
  });
});

describe('display', () => {
  it('gives art to every card and a cutout only to SSR and above that have one', async () => {
    const api = fakeApi();
    const cards = await displayCards(api, [
      serverCard({slot: 0, tier: 'n', cutout: {assetId: 'a-n'}, artAssetId: 'a-n'}),
      serverCard({slot: 1, tier: 'ssr', cutout: {assetId: 'a-ssr'}, artAssetId: 'a-ssr'}),
      serverCard({slot: 2, tier: 'ur', cutout: null, artAssetId: 'a-ur'}),
      serverCard({slot: 3, tier: 'lr', cutout: {assetId: 'a-lr'}, artAssetId: 'a-lr', serial: '7'}),
    ], 'd-20261015');
    expect(cards.map(card => card.id)).toEqual(['d-20261015:0', 'd-20261015:1', 'd-20261015:2', 'd-20261015:3']);
    expect(cards.map(card => card.cutoutUrl)).toEqual([undefined, 'https://cut.test/a-ssr.png', undefined, 'https://cut.test/a-lr.png']);
    expect(cards.every(card => card.artUrl.startsWith('https://art.test/'))).toBe(true);
    expect(cards[3].serial).toBe('7');
    expect(cards[0].serial).toBeUndefined();
    expect(api.cutout).toHaveBeenCalledTimes(2);
  });

  it('keys album cards by character and tier, and keeps the full art when the cutout ticket fails', async () => {
    const api = fakeApi({cutout: vi.fn(async () => { throw new Error('404'); })});
    const [card] = await displayCards(api, [serverCard({slot: null, tier: 'ssr', cutout: {assetId: 'a1'}})]);
    expect(card.id).toBe('c1:ssr');
    expect(card.cutoutUrl).toBeUndefined();
    expect(card.artUrl).toBe('https://art.test/a1.webp');
  });

  it('resolves the cover images of the state in order', async () => {
    const api = fakeApi();
    const cover = await displayCover(api, {cover: {day: '2026-10-15', assetIds: ['c1', 'c2']}} as CardState);
    expect(cover).toEqual({assetIds: ['c1', 'c2'], imageUrls: ['https://art.test/c1.webp', 'https://art.test/c2.webp']});
    expect((await displayCover(api, {cover: null} as CardState)).imageUrls).toEqual([]);
  });
});

describe('retry keys and the last result', () => {
  it('persists the key before the request and reuses it until finished', () => {
    const first = operationId('tablet', 'd-20261015');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem('lakomics.cards.operation:d-20261015:tablet')).toBe(first);
    expect(operationId('tablet', 'd-20261015')).toBe(first);
    finishOperation('tablet', 'd-20261015');
    expect(operationId('tablet', 'd-20261015')).not.toBe(first);
  });

  it('keeps open and keep keys apart, and one connection from another', () => {
    const open = operationId('tablet', 'd-20261015');
    const keep = operationId('tablet', 'd-20261015', 'keep');
    expect(keep).not.toBe(open);
    expect(operationId('other', 'd-20261015')).not.toBe(open);
    finishOperation('tablet', 'd-20261015', 'keep');
    expect(operationId('tablet', 'd-20261015')).toBe(open);
  });

  it('replaces a stored value that is not a UUID', () => {
    localStorage.setItem('lakomics.cards.operation:d-20261015:tablet', 'not-a-uuid');
    expect(operationId('tablet', 'd-20261015')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not consume a pack when the key cannot be stored', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(() => operationId('tablet', 'd-20261015')).toThrow();
  });

  it('round-trips the last result and ignores a malformed one', () => {
    const result: OpenResult = {packId: 'd-20261015', openedAt: '2026-10-15T01:00:00Z', alreadyOpened: false, cards: Array.from({length: 5}, (_, slot) => serverCard({slot}))};
    expect(readResult('tablet')).toBeNull();
    saveResult('tablet', result);
    expect(readResult('tablet')).toEqual(result);
    expect(readResult('other')).toBeNull();
    localStorage.setItem('lakomics.cards.last:tablet', '{"cards":[1]}');
    expect(readResult('tablet')).toBeNull();
    localStorage.setItem('lakomics.cards.last:tablet', 'garbage');
    expect(readResult('tablet')).toBeNull();
  });

  it('treats a pack as undecided only before it is kept and while it has not expired', () => {
    expect(isUndecided({})).toBe(true);
    expect(isUndecided({keptAt: '2026-10-15T02:00:00Z'})).toBe(false);
    expect(isUndecided({expired: true})).toBe(false);
  });
});
