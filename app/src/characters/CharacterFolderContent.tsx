import { FolderPlusIcon } from "@heroicons/react/24/outline";
import { FolderCharacterRegistration } from "./FolderCharacterRegistration";
import { FolderRegistrationContext } from "./FolderRegistrationContext";
import { useState, type ReactNode } from "react";
import type { AlbumEntry, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { commandErrorMessage } from "../library/errorMessage";
import type { useCharacterHub } from "./useCharacterHub";
import { characterHubApi } from "./hubApi";
import { SeriesBrowser, type CharacterGalleryDrag } from "./SeriesBrowser";
import { CharacterSeriesSuggestions } from "./CharacterSeriesSuggestions";

export function CharacterFolderContent({ children, requestedAsset, onRequestedAssetHandled, clearSelectionRequest, galleryDrag, view, hub, classifications, albums = [], privacyMode, metadataVisible, thumbnailRowHeight, refreshVersion, onNavigate, onAssetsChanged }: {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag;
  children: ReactNode; view: AssetView; hub: ReturnType<typeof useCharacterHub>; classifications: ClassificationEntry[]; albums?: AlbumEntry[];
  privacyMode: boolean; metadataVisible: boolean; thumbnailRowHeight: number; refreshVersion: number; onNavigate: (view: AssetView) => void; onAssetsChanged: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [registerCharacter, setRegisterCharacter] = useState(false);
  const [seriesSuggestions, setSeriesSuggestions] = useState(false);
  const id = view.kind === "classification" ? view.classificationId : null;
  const series = hub.series.find(s => s.classificationId === id);
  const entry = classifications.find(item => item.id === id);
  const descendantSeries = Boolean(entry?.kind === "root" && entry.parentId === null && hub.series.some(item => {
    let current = classifications.find(classification => classification.id === item.classificationId);
    while (current?.parentId) {
      if (current.parentId === id) return true;
      current = classifications.find(classification => classification.id === current?.parentId);
    }
    return false;
  }));
  if (series) return <SeriesBrowser requestedAsset={requestedAsset} onRequestedAssetHandled={onRequestedAssetHandled} clearSelectionRequest={clearSelectionRequest} galleryDrag={galleryDrag} key={series.classificationId} series={series} targetId={view.kind === "classification" ? view.characterId : undefined} targets={hub.targets} classifications={classifications} albums={albums} privacyMode={privacyMode} metadataVisible={metadataVisible} thumbnailRowHeight={thumbnailRowHeight} refreshVersion={refreshVersion + hub.revision} onNavigate={onNavigate} onChanged={hub.refresh} />;
  async function register() {
    if (!id || busy) return;
    setBusy(true); setError(null);
    try { await characterHubApi.saveSeries({ classificationId: id, heroAssetId: null, autoClassify: true }); hub.refresh(); }
    catch (e) { setError(commandErrorMessage(e, "시리즈를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <FolderRegistrationContext.Provider value={id ? <>{descendantSeries && <Button size="sm" variant="ghost" onClick={() => setSeriesSuggestions(true)}>작품 후보</Button>}<Button size="icon" variant="ghost" aria-label="시리즈로 등록" data-tooltip="시리즈로 등록" disabled={busy} onClick={() => void register()}><FolderPlusIcon aria-hidden="true" /></Button><Button size="sm" variant="ghost" onClick={() => setRegisterCharacter(true)}>캐릭터로 등록</Button></> : null}>
    <div className="character-folder-content">{(error || hub.error) && <p className="character-message" role="alert">{error || hub.error}</p>}{children}{registerCharacter && id && <FolderCharacterRegistration key={id} folderId={id} classifications={classifications} targets={hub.targets} privacyMode={privacyMode} onClose={() => setRegisterCharacter(false)} onSaved={target => { setRegisterCharacter(false); hub.refresh(); onNavigate({ kind: "classification", classificationId: target.seriesClassificationId!, characterId: target.id }); }} />}{seriesSuggestions && id && entry && <CharacterSeriesSuggestions rootId={id} rootName={entry.name} privacyMode={privacyMode} onClose={() => setSeriesSuggestions(false)} onMoved={onAssetsChanged} />}</div>
  </FolderRegistrationContext.Provider>;
}
