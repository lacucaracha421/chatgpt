import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssetGallery } from './AssetGallery';
import type { AssetSummary } from '../library/types';
import { MotionScope } from '../shared/motion/AreaSwitch';

const animate = vi.fn(() => ({cancel: vi.fn()}));
const asset = (i: number): AssetSummary => ({id: `motion-${i}`, title: null, originalName: `motion-${i}.png`, byteSize: 1, width: 200, height: 200, collectedAt: '2026-10-02T00:00:00Z', favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: {kind: 'image'}});
beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {configurable: true, get: () => 840}, clientWidth: {configurable: true, get: () => 840},
    offsetHeight: {configurable: true, get: () => 600}, clientHeight: {configurable: true, get: () => 600},
    animate: {configurable: true, value: animate},
  });
  vi.stubGlobal('CSS', {supports: () => false});
});
afterEach(() => {cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; vi.unstubAllGlobals(); animate.mockClear();});

it.each(['masonry', 'justified'] as const)('animates only the first loaded %s batch, preserving paging, sorting, filtering and revisits', layout => {
  const tree = (items: AssetSummary[], scopeKey: string, mounted = true) => <MotionScope>{mounted && <AssetGallery layout={layout} items={items} scopeKey={scopeKey}/>}</MotionScope>;
  const view = render(tree([], 'initial')); expect(animate).not.toHaveBeenCalled();
  const items = Array.from({length: 6}, (_, i) => asset(i));
  view.rerender(tree(items, 'initial')); const first = animate.mock.calls.length;
  expect(first).toBeGreaterThan(0);
  view.rerender(tree([...items, asset(6)], 'initial'));
  view.rerender(tree([...items].reverse(), 'sort'));
  view.rerender(tree(items.slice(0, 2), 'filter'));
  view.rerender(tree([...items], 'refresh'));
  view.rerender(tree([], 'away', false)); view.rerender(tree(items, 'revisit'));
  expect(animate).toHaveBeenCalledTimes(first);
});
it('keeps the initial gallery still with reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  render(<MotionScope><AssetGallery layout="masonry" items={[asset(0)]}/></MotionScope>);
  expect(animate).not.toHaveBeenCalled();
});
