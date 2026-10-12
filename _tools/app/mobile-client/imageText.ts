import type {AssetImageText, LibraryGateway} from '../src/library/types';
import {api, ApiError} from './transport';

/** One gateway per viewer session; deduplicate reads and retain the server digest. */
export function createImageTextGateway(): Pick<LibraryGateway, 'assetImageText'> {
  const requests = new Map<string, Promise<AssetImageText | null>>();
  const byDigest = new Map<string, AssetImageText>();
  return {assetImageText(assetId) {
    let request = requests.get(assetId);
    if (!request) {
      request = api<AssetImageText>(`/v1/library/assets/${encodeURIComponent(assetId)}/image-text`).then(text => {
        const key = `${assetId}:${text.digest}`;
        const cached = byDigest.get(key) ?? text;
        byDigest.set(key, cached);
        return cached;
      }).catch(reason => {
        if (reason instanceof ApiError && reason.status === 404) return null;
        requests.delete(assetId);
        throw reason;
      });
      requests.set(assetId, request);
    }
    return request;
  }};
}
