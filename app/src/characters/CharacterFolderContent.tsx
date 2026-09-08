import { useState, type ReactNode } from "react";
import type { AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { commandErrorMessage } from "../library/errorMessage";
import type { useCharacterHub } from "./useCharacterHub";
import { characterHubApi } from "./hubApi";
import { SeriesBrowser, type CharacterGalleryDrag } from "./SeriesBrowser";

export function CharacterFolderContent({ children, requestedAsset, onRequestedAssetHandled, clearSelectionRequest, galleryDrag, view, hub, classifications, privacyMode, metadataVisible, thumbnailRowHeight, refreshVersion, onNavigate }: {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag;
  children: ReactNode; view: AssetView; hub: ReturnType<typeof useCharacterHub>; classifications: ClassificationEntry[];
  privacyMode: boolean; metadataVisible: boolean; thumbnailRowHeight: number; refreshVersion: number; onNavigate: (view: AssetView) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const id = view.kind === "classification" ? view.classificationId : null;
  const series = hub.series.find(s => s.classificationId === id);
  if (series) return <SeriesBrowser requestedAsset={requestedAsset} onRequestedAssetHandled={onRequestedAssetHandled} clearSelectionRequest={clearSelectionRequest} galleryDrag={galleryDrag} key={series.classificationId} series={series} targetId={view.kind === "classification" ? view.characterId : undefined} targets={hub.targets} classifications={classifications} privacyMode={privacyMode} metadataVisible={metadataVisible} thumbnailRowHeight={thumbnailRowHeight} refreshVersion={refreshVersion + hub.revision} onNavigate={onNavigate} onChanged={hub.refresh} />;
  async function register() {
    if (!id || busy) return;
    setBusy(true); setError(null);
    try { await characterHubApi.saveSeries({ classificationId: id, heroAssetId: null, autoClassify: true }); hub.refresh(); }
    catch (e) { setError(commandErrorMessage(e, "시리즈를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <div className="character-folder-content">{id && <div className="series-registration"><Button size="sm" disabled={busy} onClick={() => void register()}>시리즈로 등록</Button>{(error || hub.error) && <span role="alert">{error || hub.error}</span>}</div>}{children}</div>;
}
