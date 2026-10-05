import { AssetImage } from "../privacy/AssetImage";
import type { CharacterTarget } from "../characters/api";
import { Toast } from "../shared/ui/Toast";
import { thumbnailUrl } from "./mediaUrl";

/** The "N장 → name" notice after assets are put into a character; shared by plain and series folders. */
export type CharacterAssignNoticeState = { id: number; count: number; target: CharacterTarget };

export function CharacterAssignToast({ notice, privacyMode, busy, onOpen, onDismiss }: { notice: CharacterAssignNoticeState; privacyMode: boolean; busy: boolean; onOpen: () => void; onDismiss: () => void }) {
  return <Toast secondaryActionLabel="열기" onSecondaryAction={onOpen} actionDisabled={busy} onDismiss={onDismiss}><span className="character-assign-notice">
    {privacyMode ? <span className="character-assign-notice__thumbnail character-assign-notice__thumbnail--private" aria-hidden="true" /> : <CharacterNoticeThumbnail target={notice.target} />}
    <span><strong>{notice.count.toLocaleString("ko-KR")}장</strong> → {notice.target.displayName}</span>
  </span></Toast>;
}

function CharacterNoticeThumbnail({ target }: { target: CharacterTarget }) {
  const assetId = target.thumbnailAssetId ?? target.references.find(reference => reference.status === "ready")?.assetId;
  return assetId
    ? <AssetImage className="character-assign-notice__thumbnail" src={thumbnailUrl(assetId)} alt="" />
    : <span className="character-assign-notice__thumbnail" aria-hidden="true" />;
}

/** Briefly marks the tiles that just went into a character, without re-rendering the gallery. */
export function markAssignedTiles(assetIds: string[], characterName: string) {
  const selected = new Set(assetIds);
  document.querySelectorAll<HTMLElement>(".asset-gallery__asset[data-asset-id]").forEach(tile => {
    if (!tile.dataset.assetId || !selected.has(tile.dataset.assetId)) return;
    tile.querySelector(".asset-gallery__character-assigned")?.remove();
    const marker = document.createElement("span");
    marker.className = "asset-gallery__character-assigned";
    marker.textContent = `✓ ${characterName}`;
    tile.append(marker);
    window.setTimeout(() => marker.remove(), 2_000);
  });
}
