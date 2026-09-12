import { FolderPlusIcon } from "@heroicons/react/24/outline";
import { CharacterFolderOrganizer } from "./CharacterFolderOrganizer";
import { FolderRegistrationContext } from "./FolderRegistrationContext";
import { useState, type ReactNode } from "react";
import type { AlbumEntry, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { commandErrorMessage } from "../library/errorMessage";
import type { useCharacterHub } from "./useCharacterHub";
import { characterHubApi } from "./hubApi";
import { SeriesBrowser, type CharacterGalleryDrag } from "./SeriesBrowser";

export function CharacterFolderContent({ children, requestedAsset, onRequestedAssetHandled, clearSelectionRequest, galleryDrag, view, hub, classifications, albums = [], galleryLayout, onGalleryLayoutChange, privacyMode, onPrivacyModeChange, metadataVisible, onMetadataVisibleChange, thumbnailRowHeight, onThumbnailRowHeightChange, refreshVersion, onNavigate, onAssetsChanged }: {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag;
  children: ReactNode; view: AssetView; hub: ReturnType<typeof useCharacterHub>; classifications: ClassificationEntry[]; albums?: AlbumEntry[];
  galleryLayout: "masonry" | "justified"; onGalleryLayoutChange: (layout: "masonry" | "justified") => void;
  privacyMode: boolean; onPrivacyModeChange: (value: boolean) => void;
  metadataVisible: boolean; onMetadataVisibleChange: (value: boolean) => void;
  thumbnailRowHeight: number; onThumbnailRowHeightChange: (value: number) => void;
  refreshVersion: number; onNavigate: (view: AssetView) => void; onAssetsChanged: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [organizeCharacter, setOrganizeCharacter] = useState(false);
  const id = view.kind === "classification" ? view.classificationId : null;
  const series = hub.series.find(s => s.classificationId === id);
  const originalScope = Boolean(id && (() => {
    let current = classifications.find(item => item.id === id);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (!current.parentId) return current.id === "lakomics-originals" || current.name === "오리지널";
      current = classifications.find(item => item.id === current?.parentId);
    }
    return false;
  })());
  if (series && !originalScope) return <SeriesBrowser requestedAsset={requestedAsset} onRequestedAssetHandled={onRequestedAssetHandled} clearSelectionRequest={clearSelectionRequest} galleryDrag={galleryDrag} key={series.classificationId} series={series} targetId={view.kind === "classification" ? view.characterId : undefined} groupId={view.kind === "classification" ? view.characterGroupId : undefined} targets={hub.targets} groups={hub.groups} classifications={classifications} albums={albums} galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange} privacyMode={privacyMode} onPrivacyModeChange={onPrivacyModeChange} metadataVisible={metadataVisible} onMetadataVisibleChange={onMetadataVisibleChange} thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange} refreshVersion={refreshVersion + hub.revision} onNavigate={onNavigate} onChanged={hub.refresh} />;
  async function register() {
    if (!id || busy) return;
    setBusy(true); setError(null);
    try { await characterHubApi.saveSeries({ classificationId: id, heroAssetId: null, autoClassify: true }); hub.refresh(); }
    catch (e) { setError(commandErrorMessage(e, "시리즈를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <FolderRegistrationContext.Provider value={id && !originalScope ? <><Button size="icon" variant="ghost" aria-label="시리즈로 등록" data-tooltip="시리즈로 등록" disabled={busy} onClick={() => void register()}><FolderPlusIcon aria-hidden="true" /></Button><Button size="sm" variant="ghost" onClick={() => setOrganizeCharacter(true)}>캐릭터로 만들기</Button></> : null}>
    <div className="character-folder-content">{(error || hub.error) && <p className="character-message" role="alert">{error || hub.error}</p>}{children}{organizeCharacter && id && <CharacterFolderOrganizer key={id} folderId={id} classifications={classifications} targets={hub.targets} privacyMode={privacyMode} onClose={() => setOrganizeCharacter(false)} onSingleSaved={target => { setOrganizeCharacter(false); onAssetsChanged(); onNavigate({ kind: "classification", classificationId: target.seriesClassificationId!, characterId: target.id }); }} />}</div>
  </FolderRegistrationContext.Provider>;
}
