import { RegistrationScope } from "./RegistrationScope";
import { SeriesPicker } from "./SeriesPicker";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLibrary } from "../library/LibraryContext";
import type { AssetCursor, AssetSummary, ClassificationEntry } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { Select } from "../shared/ui/Select";
import { TextField } from "../shared/ui/TextField";
import { AssetGallery } from "../assets/AssetGallery";
import type { CharacterTarget } from "./api";
import { ReferenceCandidateDialog } from "./ReferenceCandidateDialog";
import "./CharacterManagement.css";

type FolderRegistrationResult = {
  target: CharacterTarget;
  linkedAssetCount: number;
  referenceCandidateCount: number;
  sourceFolderRemoved: boolean;
};

export function FolderCharacterRegistration({ folderId, classifications, targets, privacyMode, onClose, onSaved }: {
  folderId: string; classifications: ClassificationEntry[]; targets: CharacterTarget[]; privacyMode: boolean;
  onClose: () => void; onSaved: (target: CharacterTarget) => void;
}) {
  const { gateway } = useLibrary();
  const ancestors = useMemo(() => {
    const result: ClassificationEntry[] = [];
    let id: string | null = folderId;
    while (id && !result.some(entry => entry.id === id)) {
      const entry = classifications.find(entry => entry.id === id);
      if (!entry) break;
      result.push(entry); id = entry.parentId;
    }
    return result;
  }, [classifications, folderId]);
  const [seriesId, setSeriesId] = useState(ancestors[1]?.id ?? folderId);
  const [chosenSeries, setChosenSeries] = useState<ClassificationEntry | null>(null);
  const [chooseSeries, setChooseSeries] = useState(false);
  const seriesEntry = chosenSeries?.id === seriesId ? chosenSeries : classifications.find(entry => entry.id === seriesId);
  const relocates = !ancestors.some(entry => entry.id === seriesId);
  useEffect(() => { if (seriesEntry?.isContainer) setChooseSeries(true); }, [seriesEntry?.id, seriesEntry?.isContainer]);
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState(ancestors[0]?.name ?? "");
  const [recursive, setRecursive] = useState(false);
  const [cleanupFolder, setCleanupFolder] = useState(true);
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [cursor, setCursor] = useState<AssetCursor | null>(null);
  const [snapshot, setSnapshot] = useState<{ count: number; fingerprint: string } | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [converted, setConverted] = useState<FolderRegistrationResult | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const query = useMemo(() => ({ albumId: null, collectionId: null, unclassifiedOnly: false, aspectRatio: null, randomPivot: null, classificationId: folderId, directOnly: !recursive, sort: "newest" as const, mediaKind: "images" as const, limit: 100 }), [folderId, recursive]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void Promise.all([gateway.listAssets({ ...query, after: null }), invoke<{ count: number; fingerprint: string }>("character_folder_asset_snapshot", { folderId, recursive })]).then(([page, nextSnapshot]) => {
      if (!active) return;
      // Only still images can be selected as recognition references or portraits.
      setItems(page.items.filter(asset => asset.media.kind === "image"));
      setThumbnail(current => page.items.some(asset => asset.id === current) ? current : null);
      setCursor(page.nextCursor); setSnapshot(nextSnapshot);
    }).catch(reason => { if (active) setError(commandErrorMessage(reason, "폴더를 불러오지 못했습니다.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [gateway, query]);
  async function more() {
    if (!cursor || loading) return;
    setLoading(true);
    try { const page = await gateway.listAssets({ ...query, after: cursor }); setItems(old => [...old, ...page.items.filter(asset => asset.media.kind === "image")]); setCursor(page.nextCursor); }
    catch (reason) { setError(commandErrorMessage(reason, "이미지를 불러오지 못했습니다.")); }
    finally { setLoading(false); }
  }
  async function save() {
    if (busy || !snapshot) return;
    setBusy(true); setError(null);
    try {
      const target = targets.find(target => target.id === targetId);
      const saved = await invoke<FolderRegistrationResult>("register_character_folder", { request: {
        folderId, seriesId, recursive, expectedCount: snapshot.count, expectedAssetFingerprint: snapshot.fingerprint, targetId: targetId || null,
        expectedFingerprint: target?.fingerprint ?? null, displayName: name,
        cleanupFolder, referenceIds: [], thumbnailId: target ? null : thumbnail,
      } });
      if (saved.referenceCandidateCount > 0) setConverted(saved);
      else onSaved(saved.target);
    } catch (reason) { setError(commandErrorMessage(reason, "캐릭터 폴더를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  if (converted) return <ReferenceCandidateDialog
    target={converted.target}
    privacyMode={privacyMode}
    onClose={() => onSaved(converted.target)}
    onSaved={onSaved}
  />;

  return <Dialog open title="한 캐릭터 폴더 정리" variant="wide" onClose={() => { if (!busy && !previewPending) onClose(); }}>
    <div className="character-picker">
      <Select label="시리즈" value={seriesId} disabled={busy || previewPending} onChange={event => { setSeriesId(event.target.value); setTargetId(""); }}>
        {[...ancestors, ...(chosenSeries && !ancestors.some(entry => entry.id === chosenSeries.id) ? [chosenSeries] : [])].map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </Select>
      <Select label="연결 대상" value={targetId} disabled={busy || previewPending} onChange={event => setTargetId(event.target.value)}>
        <option value="">새 캐릭터</option>{targets.filter(target => target.seriesClassificationId === seriesId && target.enabled).map(target => <option key={target.id} value={target.id}>{target.displayName}</option>)}
      </Select>
      {!targetId && <TextField label="캐릭터 이름" value={name} disabled={busy || previewPending} onChange={event => setName(event.target.value)} />}
      <label><input type="checkbox" checked={recursive} disabled={busy || previewPending || loading} onChange={event => setRecursive(event.target.checked)} />하위 폴더 포함</label>
      <label><input type="checkbox" checked={cleanupFolder} disabled={busy || previewPending} onChange={event => setCleanupFolder(event.target.checked)} />전환 후 기존 폴더 정리</label>
      <p>{relocates ? `선택한 자산을 ${seriesEntry?.name ?? "선택한 시리즈"} 폴더로 옮겨 연결합니다. 선택하지 않은 자산과 원본 파일을 유지합니다.` : cleanupFolder ? "이미지·GIF·영상을 연결하고, 직접 소속 자산은 시리즈로 옮깁니다. 하위 폴더와 남은 자산이 있으면 기존 폴더를 보존합니다." : "기존 분류 폴더를 유지합니다."}</p>
      <p><BusyLabel busy={!!(snapshot === null)} idle={snapshot ? `${snapshot.count}개 자산 연결 예정` : null}>대상 확인 중…</BusyLabel> · 원본 파일과 다른 캐릭터 연결을 유지합니다.</p>
      {!targetId && <><div className="character-actions"><strong>대표 이미지</strong><span>{thumbnail ? "선택됨" : "선택 사항"}</span></div>
        <div className="character-picker__gallery" inert={loading || previewPending ? true : undefined}><AssetGallery layout="masonry" items={items} privacyMode={privacyMode} targetRowHeight={140} selectedAssetIds={new Set(thumbnail ? [thumbnail] : [])} onSelectionGesture={asset => {
          if (!busy) setThumbnail(old => old === asset.id ? null : asset.id);
        }} /></div></>}
      {error && <p role="alert">{error}</p>}
      <RegistrationScope onPendingChange={setPreviewPending} request={{ seriesId, mode: "folder" }} entries={chosenSeries ? [...classifications.filter(entry => entry.id !== chosenSeries.id), chosenSeries] : classifications} onSeriesSelected={entry => { setChosenSeries(entry); setSeriesId(entry.id); setTargetId(""); }}>
      {(guard, pending) => <div className="character-actions"><Button disabled={busy || previewPending || pending || loading || !cursor} onClick={() => void more()}>더 불러오기</Button><Button disabled={busy || previewPending || loading || !snapshot?.count || (!targetId && !name.trim())} onClick={() => guard(save)}>캐릭터로 전환</Button><Button disabled={busy || previewPending} onClick={onClose}>취소</Button></div>}
      </RegistrationScope>
      {chooseSeries && seriesEntry && <SeriesPicker parent={seriesEntry} entries={classifications} onClose={onClose} onSelected={entry => { setChosenSeries(entry); setSeriesId(entry.id); setTargetId(""); setChooseSeries(false); }} />}
    </div>
  </Dialog>;
}
