import { FolderPlusIcon } from "@heroicons/react/24/outline";
import { FolderRegistrationContext } from "./FolderRegistrationContext";
import { useState, type ReactNode } from "react";
import type { AlbumEntry, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { commandErrorMessage } from "../library/errorMessage";
import type { useCharacterHub } from "./useCharacterHub";
import { characterHubApi } from "./hubApi";
import { SeriesBrowser, type CharacterGalleryDrag } from "./SeriesBrowser";

export function CharacterFolderContent({ children, requestedAsset, onRequestedAssetHandled, clearSelectionRequest, galleryDrag, view, hub, classifications, albums = [], privacyMode, metadataVisible, thumbnailRowHeight, refreshVersion, onNavigate }: {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag;
  children: ReactNode; view: AssetView; hub: ReturnType<typeof useCharacterHub>; classifications: ClassificationEntry[]; albums?: AlbumEntry[];
  privacyMode: boolean; metadataVisible: boolean; thumbnailRowHeight: number; refreshVersion: number; onNavigate: (view: AssetView) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const id = view.kind === "classification" ? view.classificationId : null;
  const series = hub.series.find(s => s.classificationId === id);
  if (series) return <SeriesBrowser requestedAsset={requestedAsset} onRequestedAssetHandled={onRequestedAssetHandled} clearSelectionRequest={clearSelectionRequest} galleryDrag={galleryDrag} key={series.classificationId} series={series} targetId={view.kind === "classification" ? view.characterId : undefined} targets={hub.targets} classifications={classifications} albums={albums} privacyMode={privacyMode} metadataVisible={metadataVisible} thumbnailRowHeight={thumbnailRowHeight} refreshVersion={refreshVersion + hub.revision} onNavigate={onNavigate} onChanged={hub.refresh} />;
  async function register() {
    if (!id || busy) return;
    setBusy(true); setError(null);
    try { await characterHubApi.saveSeries({ classificationId: id, heroAssetId: null, autoClassify: true }); hub.refresh(); }
    catch (e) { setError(commandErrorMessage(e, "시리즈를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <FolderRegistrationContext.Provider value={id ? <Button size="icon" variant="ghost" aria-label="시리즈로 등록" data-tooltip="시리즈로 등록" disabled={busy} onClick={() => void register()}><FolderPlusIcon aria-hidden="true" /></Button> : null}>
    <div className="character-folder-content">{(error || hub.error) && <p className="character-message" role="alert">{error || hub.error}</p>}{children}</div>
  </FolderRegistrationContext.Provider>;
}
