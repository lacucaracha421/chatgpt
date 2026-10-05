import { expect, it, vi } from 'vitest';
import { readDuplicateCount } from './duplicateCount';

it('uses the native count-only path without pulling review evidence', async () => {
  const gateway = { listCatalogReview: vi.fn(), getCatalogReviewCount: vi.fn().mockResolvedValue(7) };
  expect(await readDuplicateCount(gateway)).toBe(7);
  expect(gateway.getCatalogReviewCount).toHaveBeenCalledOnce();
  expect(gateway.listCatalogReview).not.toHaveBeenCalled();
});
