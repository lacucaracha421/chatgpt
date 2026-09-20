import {describe, expect, it} from 'vitest';
import {EMPTY_FILTERS, filterKey, filterParams, filterVersionOf, hasActiveFilters, sameFilters, withFilters} from './assetFilters';
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
