import { AssetImage } from "../privacy/AssetImage";
import { thumbnailUrl } from "../assets/mediaUrl";

/** A square artist cover using the same 1 + 2 split as the mobile folder tile. */
export function ArtistCollage({ assetIds, privacyMode, className = "" }: { assetIds: string[]; privacyMode: boolean; className?: string }) {
  const ids = assetIds.slice(0, 3);
  const cells = ids.length > 0 ? ids : [undefined];
  const count = cells.length;
  return <span className={`artist-collage artist-collage--n${count}${className ? ` ${className}` : ""}`} aria-hidden="true">
    {cells.map((assetId, index) => <span key={`${assetId ?? "empty"}-${index}`} className="artist-collage__cell">
      {assetId && !privacyMode && <AssetImage src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />}
    </span>)}
  </span>;
}
