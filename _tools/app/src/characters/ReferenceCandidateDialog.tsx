import { useEffect, useMemo, useState } from "react";
import { AssetGallery } from "../assets/AssetGallery";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import type { CharacterTarget } from "./api";
import {
  characterHubApi,
  type ReferenceCandidateApi,
  type ReferenceCandidateSet,
} from "./hubApi";

export function ReferenceCandidateDialog({ target, privacyMode, onClose, onSaved, api = characterHubApi }: {
  target: CharacterTarget;
  privacyMode: boolean;
  onClose: () => void;
  onSaved: (target: CharacterTarget) => void;
  api?: ReferenceCandidateApi;
}) {
  const [page, setPage] = useState<ReferenceCandidateSet | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPage(null);
    setSelected(new Set());
    setError(null);
    void api.referenceCandidates(target.id, 20).then(next => {
      if (!active) return;
      setPage(next);
      setSelected(new Set(next.suggestedAssetIds));
    }).catch(reason => {
      if (active) setError(commandErrorMessage(reason, "레퍼런스 후보를 불러오지 못했습니다."));
    });
    return () => { active = false; };
  }, [api, target.id]);

  const orderedSelected = useMemo(() => page
    ? page.suggestedAssetIds.filter(id => selected.has(id))
    : [], [page, selected]);

  function toggle(assetId: string) {
    if (busy) return;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  async function confirm() {
    if (!page || busy || orderedSelected.length < page.minimumSelection) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.confirmReferenceBatch({
        targetId: page.targetId,
        expectedRevision: page.targetRevision,
        expectedReferenceSetHash: page.referenceSetHash,
        confirmationMode: page.confirmationMode,
        assetIds: orderedSelected,
      });
      onSaved(saved);
    } catch (reason) {
      setError(commandErrorMessage(reason, "레퍼런스를 적용하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open title="레퍼런스 선택" variant="wide" onClose={() => { if (!busy) onClose(); }}>
    <div className="character-reference-dialog">
      <p>추천 이미지를 확인하고 잘못된 항목만 빼주세요. 과거 이미지는 자동으로 다시 분석하지 않습니다.</p>
      <p className="series-description">자동 확정은 같은 캐릭터를 지지하는 레퍼런스가 6장 이상일 때만 가능합니다.</p>
      {!page && !error ? <p>추천 이미지를 고르는 중…</p> : null}
      {page && page.items.length === 0 ? <p>추천할 이미지가 없습니다. 캐릭터 폴더에서 직접 확인한 이미지를 더 모은 뒤 다시 시도해 주세요.</p> : null}
      {page && page.items.length > 0 ? <div className="character-reference-dialog__gallery">
        <AssetGallery
          layout="masonry"
          items={page.items}
          privacyMode={privacyMode}
          targetRowHeight={140}
          selectedAssetIds={selected}
          onSelectionGesture={asset => toggle(asset.id)}
        />
      </div> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="character-actions">
        <Button
          disabled={!page || busy || orderedSelected.length < (page?.minimumSelection ?? 1)}
          onClick={() => void confirm()}
        >
          {orderedSelected.length}장 적용
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>나중에</Button>
      </div>
    </div>
  </Dialog>;
}
