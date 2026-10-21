import { useState } from "react";
import { thumbnailUrl } from "../../assets/mediaUrl";
import { AssetStableImage } from "../../privacy/AssetImage";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { representativeAsset } from "./model";

/** Failed or removed covers fall through without replacing a still-decoding image with a blank. */
export function FavoritePortrait({ coverId, thumbnailId, firstAssetId, coverY = 50, alt = "" }: {
  coverId?: string | null; thumbnailId?: string | null; firstAssetId?: string | null; coverY?: number; alt?: string;
}) {
  const { privacyMode } = usePrivacy();
  const [failed, setFailed] = useState<string[]>([]);
  const available = (id?: string | null) => id && !failed.includes(id) ? id : null;
  const id = representativeAsset({ coverAssetId: available(coverId) }, { thumbnailAssetId: available(thumbnailId) }, available(firstAssetId));
  if (!id || privacyMode) return null;
  const next = () => setFailed(ids => ids.includes(id) ? ids : [...ids, id]);
  return <AssetStableImage src={thumbnailUrl(id)} alt={alt} draggable={false} style={{ objectPosition: `50% ${coverY}%` }} onPreloadError={next} onError={next} />;
}
