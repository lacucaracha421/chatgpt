import type { LibraryGateway } from '../library/types';

/** Home requests only the count; injected/browser gateways retain their existing seam. */
export async function readDuplicateCount(gateway: Pick<LibraryGateway, 'listCatalogReview' | 'getCatalogReviewCount'>): Promise<number> {
  if (gateway.getCatalogReviewCount) return gateway.getCatalogReviewCount();
  const page = await gateway.listCatalogReview();
  return (page?.rows ?? []).filter(row => row.state === 'pending' && row.actionable).length;
}
