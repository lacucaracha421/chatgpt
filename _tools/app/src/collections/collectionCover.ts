import { collectionSourceThumbnailUrl, thumbnailUrl, workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionSummary } from "../library/types";

/** The card cover (same rule as `collectionCoverUrl` in CollectionBrowser, which Home does not load): the chosen work artwork, else the media-vault cover asset, else the source preview. */
export function collectionCoverUrl(collection: CollectionSummary): string | null {
  return collection.selectedWorkArtworkId
    ? workArtworkThumbnailUrl(collection.selectedWorkArtworkId)
    : collection.coverAssetId
      ? thumbnailUrl(collection.coverAssetId)
      : collection.sourcePath
        ? collectionSourceThumbnailUrl(collection.id)
        : null;
}
