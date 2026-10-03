import {assetMasked, type RatedAsset} from '../src/shared/privacy/contentMask';
import {usePrivacyMode,useNsfwFilter,privacyMode,nsfwFilter} from './privacyMode';

export function useTabletAssetMask(asset?:RatedAsset|null, privacy=false):boolean {
  const [privateMode]=usePrivacyMode(),[filter]=useNsfwFilter();
  return assetMasked(privateMode||privacy,filter,asset);
}
export function mediaMasked(asset?:RatedAsset|null):boolean {
  return assetMasked(privacyMode(),nsfwFilter(),asset);
}
