import type {RatedAsset} from "../shared/privacy/contentMask";
import type {ComponentProps, ImgHTMLAttributes, SVGProps} from 'react';
import {StableImage} from '../shared/ui/StableImage';
import {useAssetMask} from './PrivacyContext';

function assetId(src: unknown): string | undefined {
  if(typeof src!=='string') return;
  const match=src.match(/\/(?:thumbnail|asset|trash-thumbnail|video-scrub-frame)\/([^/?]+)/);
  try {return match?decodeURIComponent(match[1]):undefined;} catch {return;}
}
/** ID-only covers start masked until their batched summary read establishes a safe rating. */
export function AssetImage({asset,...props}:ImgHTMLAttributes<HTMLImageElement>&{asset?:RatedAsset}) {
  const id=assetId(props.src);
  const masked=useAssetMask(asset??id) && Boolean(asset||id);
  return masked?<span className={`${props.className??''} privacy-mask`} aria-label="이미지 숨김" style={{display:'block',width:props.width??'100%',height:props.height??'100%',...props.style}}/>:<img {...props}/>;
}
export function AssetStableImage({asset,...props}:ComponentProps<typeof StableImage>&{asset?:RatedAsset}) {
  const id=assetId(props.src);
  const masked=useAssetMask(asset??id) && Boolean(asset||id);
  const prefetchId=assetId(props.prefetchSrc);
  const prefetchMasked=useAssetMask(prefetchId) && !!prefetchId;
  return masked?<span className={`${props.className??''} privacy-mask`} aria-label="이미지 숨김" style={{display:'block',width:props.width??'100%',height:props.height??'100%',...props.style}}/>:<StableImage {...props} prefetchSrc={prefetchMasked?undefined:props.prefetchSrc}/>;
}

export function AssetSvgImage(props:SVGProps<SVGImageElement>) {
  const id=assetId(props.href); const masked=useAssetMask(id) && !!id;
  return masked?<rect width={props.width} height={props.height} fill="currentColor" aria-label="이미지 숨김"/>:<image {...props}/>;
}
