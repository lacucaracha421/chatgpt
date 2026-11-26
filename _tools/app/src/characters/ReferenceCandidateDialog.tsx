import { BusyLabel } from "../shared/ui/BusyLabel";
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
        regions: Object.fromEntries(
          orderedSelected.flatMap(id => page.regions?.[id] ? [[id, page.regions[id]]] : []),
        ),
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
      <p>잘못된 추천 항목만 해제 · 과거 이미지 자동 재분석 안 함</p>
      <p className="series-description">자동 확정 조건: 레퍼런스 6장 이상</p>
      <BusyLabel busy={!page && !error}><p>추천 이미지 고르는 중…</p></BusyLabel>
      {page && page.items.length === 0 ? <p>추천할 이미지 없음 · 확인된 이미지 추가 후 재시도</p> : null}
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
