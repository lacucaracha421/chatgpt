import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { TextField } from "../shared/ui/TextField";
import { commandErrorMessage } from "../library/errorMessage";
import type { CharacterTarget } from "./api";
import {
  characterHubApi,
  type CharacterFolderMigrationApi,
  type FinalizeMixedFolderResult,
  type MixedFolderPreview,
} from "./hubApi";
import "./SeriesBrowser.css";

type Props = {
  folderId: string;
  targets: CharacterTarget[];
  onClose: () => void;
  onFinished: (result: FinalizeMixedFolderResult) => void;
  api?: CharacterFolderMigrationApi;
};

export function MixedCharacterFolderMigration({ folderId, targets, onClose, onFinished, api = characterHubApi }: Props) {
  const [preview, setPreview] = useState<MixedFolderPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const selectionTouched = useRef(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api.mixedFolderPreview(folderId);
      setPreview(next);
      setGroupName(current => current || next.folderName);
      setError(null);
    } catch (reason) {
      setError(commandErrorMessage(reason, "혼합 폴더를 확인하지 못했습니다."));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [api, folderId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!preview?.pendingCount) return;
    const timer = window.setInterval(() => void load(true), 1500);
    return () => window.clearInterval(timer);
  }, [preview?.pendingCount, load]);

  const seriesTargets = useMemo(() => {
    if (!preview) return [];
    const counts = new Map(preview.targetCounts.map(row => [row.targetId, row.count]));
    const grouped = new Set(preview.groupedTargetIds);
    return targets
      .filter(target => target.seriesClassificationId === preview.seriesId && target.enabled)
      .map(target => ({ target, count: counts.get(target.id) ?? 0, grouped: grouped.has(target.id) }))
      .sort((left, right) => right.count - left.count || left.target.displayName.localeCompare(right.target.displayName));
  }, [preview, targets]);

  useEffect(() => {
    if (!preview || preview.pendingCount || selectionTouched.current) return;
    const detected = seriesTargets.filter(row => row.count > 0 && !row.grouped).map(row => row.target.id);
    if (detected.length) setSelected(detected);
  }, [preview, seriesTargets]);

  async function queueAnalysis() {
    if (!preview || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const queued = await api.queueMixedFolder({
        folderId: preview.folderId,
        seriesId: preview.seriesId,
        expectedTotalCount: preview.totalCount,
        expectedImageCount: preview.imageCount,
        expectedAssetFingerprint: preview.assetFingerprint,
      });
      setNotice(queued ? `${queued.toLocaleString()}장 분석을 예약했습니다.` : "이미 분석 중인 이미지가 있습니다.");
      await load(true);
    } catch (reason) {
      setError(commandErrorMessage(reason, "폴더 분석을 시작하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    if (!preview || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api.finalizeMixedFolder({
        folderId: preview.folderId,
        seriesId: preview.seriesId,
        expectedTotalCount: preview.totalCount,
        expectedImageCount: preview.imageCount,
        expectedAssetFingerprint: preview.assetFingerprint,
        groupName,
        targetIds: selected,
      });
      onFinished(result);
    } catch (reason) {
      setError(commandErrorMessage(reason, "캐릭터 구조 정리를 완료하지 못했습니다."));
      await load(true);
    } finally {
      setBusy(false);
    }
  }

  const analyzed = preview ? preview.resolvedCount + preview.reviewCount + preview.failedCount : 0;
  const readyTargets = seriesTargets.filter(row => row.target.ready).length;
  const canFinalize = Boolean(preview && !busy && preview.imageCount > 0 && preview.pendingCount === 0 && preview.unscannedCount === 0 && selected.length >= 2 && groupName.trim());
  const finalizeHint = !preview ? null
    : preview.imageCount === 0 ? "정리할 이미지가 없습니다."
    : preview.pendingCount > 0 ? `분석 대기 ${preview.pendingCount.toLocaleString()}장`
    : preview.unscannedCount > 0 ? `미분석 ${preview.unscannedCount.toLocaleString()}장`
    : selected.length < 2 ? `그룹 멤버 ${2 - selected.length}명 더 선택`
    : !groupName.trim() ? "그룹 이름 입력 필요"
    : null;

  return <Dialog open title="여러 캐릭터 폴더 정리" variant="wide" onClose={() => { if (!busy) onClose(); }}>
    <div className="mixed-character-migration">
      {loading && !preview ? <p className="character-series-suggestions__empty">폴더를 확인하는 중…</p> : preview && <>
        <section className="mixed-character-migration__summary">
          <div><strong>{preview.folderName}</strong><span>→ {preview.seriesName}</span></div>
          <p>이 폴더의 이미지를 작품 캐릭터들과 비교한 뒤 작품 본체로 옮기고, 현재 폴더 이름을 캐릭터 그룹으로 남깁니다.</p>
          <p className="character-message">완료 후 그룹에는 선택한 캐릭터들의 기존 이미지도 함께 표시됩니다.</p>
          <div className="mixed-character-migration__counts">
            <span>이미지 {preview.imageCount.toLocaleString()}장</span>
            <span>분석 완료 {analyzed.toLocaleString()}장</span>
            <span>추가 확인 {preview.reviewCount.toLocaleString()}장</span>
            {preview.failedCount > 0 && <span>실패 {preview.failedCount.toLocaleString()}장</span>}
          </div>
          {preview.pendingCount > 0 && <div className="character-progress"><span>분석 중 · 남은 작업 {preview.pendingCount.toLocaleString()}장</span><progress max={Math.max(1, preview.imageCount)} value={Math.min(preview.imageCount, analyzed)} /></div>}
          {preview.otherMediaCount > 0 && <p className="character-message">GIF·영상 등 {preview.otherMediaCount.toLocaleString()}개는 자동 분석하지 않고 현재 폴더에 남깁니다.</p>}
          {preview.childFolderCount > 0 && <p className="character-message">하위 폴더 {preview.childFolderCount.toLocaleString()}개는 그대로 유지합니다.</p>}
        </section>

        <div className="character-actions">
          <Button disabled={busy || preview.pendingCount > 0 || preview.imageCount === 0 || readyTargets === 0} onClick={() => void queueAnalysis()}>{preview.unscannedCount > 0 ? "폴더 분석" : "다시 분석"}</Button>
          <span className="character-message">분석 준비된 캐릭터 {readyTargets.toLocaleString()}명</span>
        </div>

        <section className="mixed-character-migration__members" aria-label="그룹 멤버">
          <div><strong>그룹 멤버</strong><span>분석에서 발견된 캐릭터는 자동으로 선택됩니다.</span></div>
          <div className="character-group-members">
            {seriesTargets.map(({ target, count, grouped }) => <label key={target.id}>
              <input type="checkbox" disabled={busy || grouped} checked={selected.includes(target.id)} onChange={event => {
                selectionTouched.current = true;
                setSelected(current => event.target.checked ? [...current, target.id] : current.filter(id => id !== target.id));
              }} />
              <span>{target.displayName}</span>
              <small>{count > 0 ? `${count.toLocaleString()}장` : target.ready ? "일치 없음" : "분석 준비 안 됨"}{grouped ? " · 다른 그룹" : ""}</small>
            </label>)}
            {!seriesTargets.length && <p className="character-message">이 작품에 등록된 캐릭터가 없습니다. 작품 화면에서 캐릭터를 먼저 등록해 주세요.</p>}
          </div>
        </section>

        <TextField label="그룹 이름" value={groupName} maxLength={100} disabled={busy} onChange={event => setGroupName(event.target.value)} />
        {preview.unscannedCount > 0 && <p className="character-message">아직 분석하지 않은 이미지 {preview.unscannedCount.toLocaleString()}장이 있습니다.</p>}
        {preview.reviewCount > 0 && preview.pendingCount === 0 && <p className="character-message">추가 확인 이미지는 작품의 기존 검토 화면에 계속 남습니다. 지금 정리를 완료해도 나중에 캐릭터 관계를 보완할 수 있습니다.</p>}
        {error && <p className="character-message" role="alert">{error}</p>}
        {notice && <p className="character-message" role="status">{notice}</p>}
        <div className="character-actions mixed-character-migration__footer">
          <Button variant="primary" disabled={!canFinalize} onClick={() => void finalize()}>그룹으로 정리 완료</Button>
          {finalizeHint && <small role="status">{finalizeHint}</small>}
          <Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
        </div>
      </>}
      {error && !preview && <p className="character-message" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
