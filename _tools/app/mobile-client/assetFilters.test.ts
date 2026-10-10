import {describe, expect, it} from 'vitest';
import {EMPTY_FILTERS, assertAppliedQuery, filterKey, filterParams, filterVersionOf, hasActiveFilters, isRankedSort, newSeed, queryExtras, sameFilters, seedOf, sortOf, subtreeOf, withFilters, withSort, withSubtree} from './assetFilters';
import type {AssetFiltersValue} from './types';

const filters = (over: Partial<AssetFiltersValue> = {}): AssetFiltersValue => ({...EMPTY_FILTERS, ...over});
/** The parameter names the backend agent agreed, spelled once so a rename fails here. */
const params = (value: AssetFiltersValue) => [...filterParams(value)].map(([key, entry]) => [key, entry]);

describe('asset filter parameters', () => {
  it('sends nothing at all when no filter is active, so an untouched gallery keeps the previous request', () => {
    expect(params(EMPTY_FILTERS)).toEqual([]);
    expect(filterKey(EMPTY_FILTERS)).toBe('');
    expect(withFilters('/v1/library/assets?limit=40', EMPTY_FILTERS)).toBe('/v1/library/assets?limit=40');
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });
  it('uses the agreed wire names and values for media and aspect', () => {
    expect(params(filters({media:'images'}))).toEqual([['media_kind', 'images']]);
    expect(params(filters({media:'videos'}))).toEqual([['media_kind', 'videos']]);
    expect(params(filters({aspect:'square'}))).toEqual([['aspect_ratio', 'square']]);
    expect(params(filters({aspect:'landscape'}))).toEqual([['aspect_ratio', 'landscape']]);
    expect(params(filters({aspect:'portrait'}))).toEqual([['aspect_ratio', 'portrait']]);
  });
  it('expresses each duration bucket as an inclusive min and an exclusive max', () => {
    expect(params(filters({duration:'under_30s'}))).toEqual([['duration_ms_max', '30000']]);
    expect(params(filters({duration:'30s_1m'}))).toEqual([['duration_ms_min', '30000'], ['duration_ms_max', '60000']]);
    expect(params(filters({duration:'1m_5m'}))).toEqual([['duration_ms_min', '60000'], ['duration_ms_max', '300000']]);
    expect(params(filters({duration:'over_5m'}))).toEqual([['duration_ms_min', '300000']]);
  });
  it('never emits a min that reaches or exceeds its own max', () => {
    for (const bucket of ['under_30s','30s_1m','1m_5m','over_5m'] as const) {
      const entries = Object.fromEntries(params(filters({duration:bucket})));
      if (entries.duration_ms_min === undefined || entries.duration_ms_max === undefined) continue;
      expect(Number(entries.duration_ms_min)).toBeLessThan(Number(entries.duration_ms_max));
    }
  });
  it('appends with the right separator for a path that already has parameters', () => {
    expect(withFilters('/v1/albums/assets?libraryId=abc', filters({media:'videos'})))
      .toBe('/v1/albums/assets?libraryId=abc&media_kind=videos');
    expect(withFilters('/v1/library/characters/assets', filters({aspect:'square'})))
      .toBe('/v1/library/characters/assets?aspect_ratio=square');
  });
  it('keys the cache on exactly the request fields, order-stably', () => {
    expect(filterKey(filters({media:'images', aspect:'square'}))).toBe(filterKey(filters({aspect:'square', media:'images'})));
    expect(filterKey(filters({media:'images'}))).not.toBe(filterKey(filters({media:'videos'})));
    expect(filterKey(filters({aspect:'portrait'}))).toBe('aspect_ratio=portrait');
  });
  it('treats an equal set as equal and any difference as different', () => {
    expect(sameFilters(filters({media:'images'}), filters({media:'images'}))).toBe(true);
    expect(sameFilters(filters({media:'images'}), filters({media:'images', aspect:'square'}))).toBe(false);
  });
});

/**
 * The contract version is the single normalization point, so it is tested directly here:
 * every scope's guard reads this function, and a wrong answer would silently disable the
 * protection against presenting an unfiltered page as a filtered one.
 */
describe('filter contract normalization', () => {
  it('accepts exactly the implemented version', () => {
    expect(filterVersionOf({filterVersion:1})).toBe(1);
  });
  it('refuses an undeclared, alternative or future contract', () => {
    // The only agreed wire name is `filterVersion`. Guessing a snake_case variant would let a
    // server that never agreed the contract pass the guard it exists to satisfy.
    expect(filterVersionOf({filter_version:1})).toBeNull();
    expect(filterVersionOf({})).toBeNull();
    expect(filterVersionOf({filterVersion:2})).toBeNull();
    expect(filterVersionOf({filterVersion:0})).toBeNull();
    expect(filterVersionOf({filterVersion:'1'})).toBeNull();
    expect(filterVersionOf({filterVersion:1.5})).toBeNull();
    expect(filterVersionOf(null)).toBeNull();
    expect(filterVersionOf('filterVersion:1')).toBeNull();
  });
});

describe('sort, shuffle seed and folder subtree', () => {
  const SEED = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  it('sends only what differs from the default request', () => {
    expect(params(withSort(EMPTY_FILTERS, 'newest'))).toEqual([]);
    expect(params(withSort(EMPTY_FILTERS, 'oldest'))).toEqual([['sort', 'oldest']]);
    expect(params(withSort(EMPTY_FILTERS, 'favorites'))).toEqual([['sort', 'favorites']]);
    expect(params(withSort(EMPTY_FILTERS, 'random', SEED))).toEqual([['sort', 'random'], ['seed', SEED]]);
    expect(params(withSubtree(EMPTY_FILTERS, true))).toEqual([['subtree', '1']]);
    expect(params(withSubtree(withSubtree(EMPTY_FILTERS, true), false))).toEqual([]);
  });
  it('puts the sort, the seed and the mode in the request identity, so no cache or cursor is shared across them', () => {
    const keys = [EMPTY_FILTERS, withSort(EMPTY_FILTERS, 'oldest'), withSort(EMPTY_FILTERS, 'favorites'),
      withSort(EMPTY_FILTERS, 'random', SEED), withSort(EMPTY_FILTERS, 'random', 'ffffffffffffffffffffffffffffffff'),
      withSubtree(EMPTY_FILTERS, true), withSubtree(withSort(EMPTY_FILTERS, 'favorites'), true)].map(filterKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('keeps media, aspect and duration when the sort or the mode changes', () => {
    const base = filters({media: 'videos', aspect: 'square'});
    expect(params(withSubtree(withSort(base, 'random', SEED), true))).toEqual([['media_kind', 'videos'], ['aspect_ratio', 'square'], ['sort', 'random'], ['seed', SEED], ['subtree', '1']]);
  });
  it('drops the seed when leaving a shuffle and treats a shuffle without a usable seed as newest', () => {
    const shuffled = withSort(EMPTY_FILTERS, 'random', SEED);
    expect(seedOf(shuffled)).toBe(SEED);
    expect(seedOf(withSort(shuffled, 'oldest'))).toBeUndefined();
    expect((withSort(shuffled, 'oldest') as {seed?: string}).seed).toBeUndefined();
    expect(sortOf({...EMPTY_FILTERS, sort: 'random'} as never)).toBe('newest');
    expect(sortOf({...EMPTY_FILTERS, sort: 'random', seed: 'short'} as never)).toBe('newest');
    expect(sortOf({...EMPTY_FILTERS, sort: 'bogus'} as never)).toBe('newest');
    expect(params({...EMPTY_FILTERS, sort: 'random'} as never)).toEqual([]);
  });
  it('reshuffles with a new seed of the shape the server accepts', () => {
    const first = newSeed(), second = newSeed();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
    expect(seedOf(withSort(withSort(EMPTY_FILTERS, 'random', first), 'random', second))).toBe(second);
  });
  it('is not a media/aspect/duration filter: it neither narrows the list nor counts as one', () => {
    const query = withSubtree(withSort(EMPTY_FILTERS, 'random', SEED), true);
    expect(hasActiveFilters(query)).toBe(false);
    expect(sameFilters(query, EMPTY_FILTERS)).toBe(true);
    expect(subtreeOf(query)).toBe(true);
    expect(isRankedSort(sortOf(query))).toBe(true);
    expect(isRankedSort('oldest')).toBe(false);
  });
  it('carries the extras across a filter reset', () => {
    const query = withSubtree(withSort(filters({media: 'videos'}), 'random', SEED), true);
    expect(queryExtras(query)).toEqual({sort: 'random', seed: SEED, subtree: true});
    expect(params({...EMPTY_FILTERS, ...queryExtras(query)} as AssetFiltersValue)).toEqual([['sort', 'random'], ['seed', SEED], ['subtree', '1']]);
  });
});

describe('refusing a page the server did not answer under the requested query', () => {
  const SEED = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  it('never objects to the shipped sorts', () => {
    expect(() => assertAppliedQuery({items: []}, EMPTY_FILTERS)).not.toThrow();
    expect(() => assertAppliedQuery({items: []}, withSort(EMPTY_FILTERS, 'oldest'))).not.toThrow();
  });
  it('requires the echo for a subtree page and a ranked page', () => {
    expect(() => assertAppliedQuery({searchFilters: {}}, withSubtree(EMPTY_FILTERS, true))).toThrow(/하위 폴더/);
    expect(() => assertAppliedQuery({searchFilters: {subtree: 1}}, withSubtree(EMPTY_FILTERS, true))).not.toThrow();
    expect(() => assertAppliedQuery({}, withSort(EMPTY_FILTERS, 'favorites'))).toThrow(/정렬/);
    expect(() => assertAppliedQuery({searchFilters: {sort: 'favorites'}}, withSort(EMPTY_FILTERS, 'favorites'))).not.toThrow();
    expect(() => assertAppliedQuery({searchFilters: {sort: 'favorites'}}, withSort(EMPTY_FILTERS, 'random', SEED))).toThrow(/정렬/);
    expect(() => assertAppliedQuery({searchFilters: {sort: 'random'}}, withSort(EMPTY_FILTERS, 'random', SEED))).not.toThrow();
    expect(() => assertAppliedQuery(null, withSort(withSubtree(EMPTY_FILTERS, true), 'random', SEED))).toThrow();
  });
});
