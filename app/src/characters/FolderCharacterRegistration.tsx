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
import "./CharacterLab.css";

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
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState(ancestors[0]?.name ?? "");
  const [recursive, setRecursive] = useState(false);
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [cursor, setCursor] = useState<AssetCursor | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [references, setReferences] = useState<string[]>([]);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [mode, setMode] = useState<"references" | "thumbnail">("references");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const query = useMemo(() => ({ albumId: null, collectionId: null, unclassifiedOnly: false, aspectRatio: null, randomPivot: null, classificationId: folderId, directOnly: !recursive, sort: "newest" as const, mediaKind: "images" as const, limit: 100 }), [folderId, recursive]);
  useEffect(() => {
    let active = true;
    setLoading(true); setCount(null); setItems([]); setReferences([]); setThumbnail(null); setError(null);
    void Promise.all([gateway.listAssets({ ...query, after: null }), invoke<number>("character_folder_image_count", { folderId, recursive })]).then(([page, imageCount]) => {
      if (!active) return;
      // GIFs are excluded by the native registration contract as well.
      setItems(page.items.filter(asset => asset.media.kind === "image"));
      setCursor(page.nextCursor); setCount(imageCount);
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
    if (busy || count === null) return;
    setBusy(true); setError(null);
    try {
      const target = targets.find(target => target.id === targetId);
      const saved = await invoke<CharacterTarget>("register_character_folder", { request: {
        folderId, seriesId, recursive, expectedCount: count, targetId: targetId || null,
        expectedFingerprint: target?.fingerprint ?? null, displayName: name,
        referenceIds: target ? [] : references, thumbnailId: target ? null : thumbnail,
      } });
      onSaved(saved);
    } catch (reason) { setError(commandErrorMessage(reason, "캐릭터 폴더를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <Dialog open title="기존 폴더를 캐릭터로 등록" variant="wide" onClose={() => { if (!busy) onClose(); }}>
    <div className="character-picker">
      <Select label="시리즈" value={seriesId} disabled={busy} onChange={event => { setSeriesId(event.target.value); setTargetId(""); }}>
        {ancestors.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </Select>
      <Select label="연결 대상" value={targetId} disabled={busy} onChange={event => setTargetId(event.target.value)}>
        <option value="">새 캐릭터</option>{targets.filter(target => target.seriesClassificationId === seriesId && target.enabled).map(target => <option key={target.id} value={target.id}>{target.displayName}</option>)}
      </Select>
      {!targetId && <TextField label="캐릭터 이름" value={name} disabled={busy} onChange={event => setName(event.target.value)} />}
      <label><input type="checkbox" checked={recursive} disabled={busy || loading} onChange={event => setRecursive(event.target.checked)} />하위 폴더 포함</label>
      <p>{count === null ? "대상 확인 중…" : `${count}장 연결 예정`} · 파일과 기존 분류, 다른 캐릭터 연결을 유지합니다.</p>
      {!targetId && <><div className="character-actions"><Button disabled={busy} onClick={() => setMode("references")}>기준 이미지 {references.length}/5</Button><Button disabled={busy} onClick={() => setMode("thumbnail")}>대표 이미지 {thumbnail ? "선택됨" : "선택"}</Button><span>{mode === "references" ? "기준 이미지 선택" : "대표 이미지 선택"}</span></div>
        <div className="character-picker__gallery"><AssetGallery layout="masonry" items={items} privacyMode={privacyMode} targetRowHeight={140} selectedAssetIds={new Set(mode === "references" ? references : thumbnail ? [thumbnail] : [])} onSelectionGesture={asset => {
          if (busy) return;
          if (mode === "thumbnail") setThumbnail(old => old === asset.id ? null : asset.id);
          else setReferences(old => old.includes(asset.id) ? old.filter(id => id !== asset.id) : old.length < 5 ? [...old, asset.id] : old);
        }} /></div></>}
      {error && <p role="alert">{error}</p>}
      <div className="character-actions"><Button disabled={busy || loading || !cursor} onClick={() => void more()}>더 불러오기</Button><Button disabled={busy || loading || !count || (!targetId && !name.trim())} onClick={() => void save()}>등록</Button><Button disabled={busy} onClick={onClose}>취소</Button></div>
    </div>
  </Dialog>;
}
