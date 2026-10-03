import { privacyMode, nsfwFilter, usePrivacyMode, useNsfwFilter } from './privacyMode';
import { catalogContentMasked } from '../src/shared/privacy/catalogMask';

export function useTabletCatalogMasked(): boolean {
  const [privacy] = usePrivacyMode();
  const [filter] = useNsfwFilter();
  return catalogContentMasked(privacy, filter);
}

export function tabletCatalogMasked(): boolean {
  return catalogContentMasked(privacyMode(), nsfwFilter());
}
