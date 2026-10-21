import { useRef, useState } from "react";
import { thumbnailUrl } from "../../assets/mediaUrl";
import { AssetStableImage } from "../../privacy/AssetImage";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { representativeAsset } from "./model";

/** Failed or removed covers fall through without replacing a still-decoding image with a blank. */
export function FavoritePortrait({ coverId, thumbnailId, firstAssetId, coverY = 50, alt = "", name, seriesName }: {
  coverId?: string | null; thumbnailId?: string | null; firstAssetId?: string | null; coverY?: number; alt?: string;
  name?: string; seriesName?: string;
}) {
  const { privacyMode } = usePrivacy();
  const [failed, setFailed] = useState<string[]>([]);
  const [painted, setPainted] = useState(false);
  const nameCard = useRef({ name, seriesName });
  if (name !== undefined) nameCard.current = { name, seriesName };
  const available = (id?: string | null) => id && !failed.includes(id) ? id : null;
  const id = name !== undefined ? available(coverId) : representativeAsset({ coverAssetId: available(coverId) }, { thumbnailAssetId: available(thumbnailId) }, available(firstAssetId));
  if (name !== undefined && (!id || privacyMode)) return <span className="favorite-name-card"><strong>{name}</strong>{seriesName && <small>{seriesName}</small>}</span>;
  if (!id || privacyMode) return null;
  const next = () => setFailed(ids => ids.includes(id) ? ids : [...ids, id]);
  const image = <AssetStableImage src={thumbnailUrl(id)} alt={alt} draggable={false} style={{ objectPosition: `50% ${coverY}%` }} onPreloadError={next} onError={next} onLoad={event => {
    const element = event.currentTarget;
    void (element.decode?.() ?? Promise.resolve()).catch(() => undefined).then(() => { if (element.isConnected) setPainted(true); });
  }} />;
  return <>{nameCard.current.name !== undefined && !painted && <span className="favorite-name-card"><strong>{nameCard.current.name}</strong>{nameCard.current.seriesName && <small>{nameCard.current.seriesName}</small>}</span>}<span className="favorite-portrait-image">{image}</span></>;
}
