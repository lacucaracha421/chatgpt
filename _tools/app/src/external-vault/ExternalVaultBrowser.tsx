import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetGallery } from "../assets/AssetGallery";
import { AssetViewer } from "../assets/AssetViewer";
import { thumbnailUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetSummary, LibraryGateway, PrivateVaultAssetSummary, PrivateVaultThumbnailCandidate } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { TextField } from "../shared/ui/TextField";
import "./externalVault.css";

type Filter = "all" | "images" | "videos";
const PAGE_SIZE = 80;
const AUTO_SYNC_MS = 2_000;

export function ExternalVaultBrowser({ gateway, privacyMode = false }: { gateway: LibraryGateway; privacyMode?: boolean }) {
  const listAssets = gateway.listPrivateVaultAssets!;
  const scanVault = gateway.scanPrivateVault!;
  const playVideo = gateway.playPrivateVaultVideo!;
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [titleEditorOpen, setTitleEditorOpen] = useState(false);
  const [thumbnailEditorOpen, setThumbnailEditorOpen] = useState(false);
  const [thumbnailRevision, setThumbnailRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const autoSyncBusyRef = useRef(false);
  const queryKind = filter === "all" ? null : filter;
  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listAssets({ mediaKind: queryKind, offset: 0, limit: PAGE_SIZE });
      setItems(page.items.map(toAssetSummary));
      setNextOffset(page.nextOffset);
      setTotalCount(page.totalCount);
    } catch (cause) {
      setItems([]);
      setNextOffset(null);
      setTotalCount(0);
      setError(commandErrorMessage(cause, "비밀 보관함을 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [listAssets, queryKind]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);
  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [items, selectedId]);

  const loadNext = useCallback(async () => {
    if (nextOffset === null) return;
    try {
      const page = await listAssets({ mediaKind: queryKind, offset: nextOffset, limit: PAGE_SIZE });
      setItems((current) => [...current, ...page.items.map(toAssetSummary)]);
      setNextOffset(page.nextOffset);
      setTotalCount(page.totalCount);
    } catch (cause) {
      setError(commandErrorMessage(cause, "다음 자산을 불러오지 못했습니다."));
    }
  }, [listAssets, nextOffset, queryKind]);
  const openVideo = useCallback(async (assetId: string) => {
    setError(null);
    try { await playVideo(assetId); }
    catch (cause) { setError(commandErrorMessage(cause, "비밀 영상을 재생하지 못했습니다.")); }
  }, [playVideo]);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { await scanVault(); await loadFirst(); }
    catch (cause) { setError(commandErrorMessage(cause, "비밀 보관함을 새로고치지 못했습니다.")); setLoading(false); }
  }, [loadFirst, scanVault]);
  const changed = useCallback(async (thumbnailChanged = false) => {
    if (thumbnailChanged) setThumbnailRevision((value) => value + 1);
    await loadFirst();
  }, [loadFirst]);
  const autoSync = useCallback(async () => {
    if (autoSyncBusyRef.current || loading || titleEditorOpen || thumbnailEditorOpen) return;
    autoSyncBusyRef.current = true;
    try {
      const report = await scanVault();
      if (report.added > 0 || report.updated > 0 || report.removed > 0 || report.failed > 0) {
        if (report.updated > 0) setThumbnailRevision((value) => value + 1);
        await loadFirst();
      }
    } catch {
      // Background reconciliation is best-effort; explicit refresh surfaces errors.
    } finally {
      autoSyncBusyRef.current = false;
    }
  }, [loadFirst, loading, scanVault, thumbnailEditorOpen, titleEditorOpen]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void autoSync();
    }, AUTO_SYNC_MS);
    return () => window.clearInterval(timer);
  }, [autoSync]);

  const active = useMemo(() => items.some((item) => item.id === viewerId) ? viewerId : null, [items, viewerId]);
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const selectedVideo = selected?.media.kind === "video" ? selected : null;
  const selectedAssetIds = useMemo(() => selectedId ? new Set([selectedId]) : new Set<string>(), [selectedId]);

  return <section className="external-vault-browser" aria-label="비밀">
    <header className="external-vault-browser__toolbar">
      <div className="external-vault-browser__filters" role="group" aria-label="미디어 필터">
        {(["all", "images", "videos"] as const).map((value) => <Button key={value} size="sm"
          variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value}
          onClick={() => setFilter(value)}>{{ all: "전체", images: "이미지", videos: "영상" }[value]}</Button>)}
      </div>
      <div className="external-vault-browser__actions">
        <Button size="sm" variant="ghost" disabled={!selectedVideo} onClick={() => setTitleEditorOpen(true)}>제목 변경</Button>
        <Button size="sm" variant="ghost" disabled={!selectedVideo} onClick={() => setThumbnailEditorOpen(true)}>썸네일 변경</Button>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>새로고침</Button>
      </div>
    </header>
    {error && <p className="external-vault-browser__error" role="alert">{error}</p>}
    {!loading && items.length === 0
      ? <EmptyState title="비밀 보관함이 비어 있습니다">이미지나 영상을 보관함에 넣은 뒤 새로고침하시와요.</EmptyState>
      : <AssetGallery items={items} layout="masonry" scopeKey={`external-vault:${filter}`} totalCount={totalCount}
          metadataVisible={!privacyMode} captionLabel={(asset) => asset.title || asset.originalName}
          privacyMode={privacyMode} thumbnailCacheKey={thumbnailRevision}
          selectedAssetIds={selectedAssetIds} focusAssetId={selectedId}
          onSelectionGesture={(asset) => setSelectedId(asset.id)} onClearSelection={() => setSelectedId(null)}
          hasNextPage={nextOffset !== null} onLoadNextPage={() => void loadNext()}
          onOpen={(asset) => { if (asset.media.kind === "video") void openVideo(asset.id); else setViewerId(asset.id); }} />}
    {active && <AssetViewer items={items} activeId={active} onActiveIdChange={setViewerId} onClose={() => setViewerId(null)} privacyMode={privacyMode} />}
    {titleEditorOpen && selectedVideo && <TitleEditor asset={selectedVideo} gateway={gateway}
      onClose={() => setTitleEditorOpen(false)} onChanged={() => void changed()} />}
    {thumbnailEditorOpen && selectedVideo && <ThumbnailEditor asset={selectedVideo} gateway={gateway}
      privacyMode={privacyMode} revision={thumbnailRevision} onClose={() => setThumbnailEditorOpen(false)}
      onChanged={() => { setThumbnailEditorOpen(false); void changed(true); }} />}
  </section>;
}

function TitleEditor({ asset, gateway, onClose, onChanged }: { asset: AssetSummary; gateway: LibraryGateway; onClose(): void; onChanged(): void }) {
  const [title, setTitle] = useState(asset.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try {
      await gateway.setPrivateVaultTitle!(asset.id, title.trim() || null);
      onChanged(); onClose();
    } catch (cause) { setError(commandErrorMessage(cause, "제목을 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <Dialog open title="제목 변경" onClose={() => { if (!busy) onClose(); }}>
    <TextField autoFocus label="제목" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
    <p className="external-vault-editor__hint">비워 두면 원본 파일명을 표시합니다.</p>
    {error && <p className="external-vault-editor__error" role="alert">{error}</p>}
    <div className="ui-dialog__actions"><Button disabled={busy} onClick={onClose}>취소</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>저장</Button></div>
  </Dialog>;
}

function ThumbnailEditor({ asset, gateway, privacyMode, revision, onClose, onChanged }: { asset: AssetSummary; gateway: LibraryGateway; privacyMode: boolean; revision: number; onClose(): void; onChanged(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Array<{ timestampMs: number; url: string }>>([]);
  const urls = useRef<string[]>([]);
  useEffect(() => () => { urls.current.forEach((url) => URL.revokeObjectURL(url)); }, []);
  function replaceCandidates(values: PrivateVaultThumbnailCandidate[]) {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    const next = values.map((candidate) => ({
      timestampMs: candidate.timestampMs,
      url: URL.createObjectURL(new Blob([new Uint8Array(candidate.imageBytes)], { type: "image/webp" })),
    }));
    urls.current = next.map((candidate) => candidate.url);
    setCandidates(next);
  }
  async function chooseFile() {
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: "썸네일 이미지", extensions: ["jpg", "jpeg", "png", "webp"] }] });
      if (typeof path !== "string") return;
      await run(() => gateway.setPrivateVaultThumbnailFromFile!(asset.id, path));
    } catch (cause) {
      setError(commandErrorMessage(cause, "이미지 파일을 선택하지 못했습니다."));
    }
  }
  async function loadFrames() {
    setBusy(true); setError(null);
    try { replaceCandidates(await gateway.listPrivateVaultThumbnailCandidates!(asset.id)); }
    catch (cause) { setError(commandErrorMessage(cause, "썸네일 후보를 만들지 못했습니다.")); }
    finally { setBusy(false); }
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await operation(); onChanged(); }
    catch (cause) { setError(commandErrorMessage(cause, "썸네일을 변경하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <Dialog open title="썸네일 변경" variant="medium" onClose={() => { if (!busy) onClose(); }}>
    <div className="external-vault-thumbnail-editor">
      <div className="external-vault-thumbnail-editor__current">
        {privacyMode ? <span>비공개 모드</span> : <img src={thumbnailUrl(asset.id, revision)} alt="현재 썸네일" />}
      </div>
      <div className="external-vault-thumbnail-editor__choices">
        <Button disabled={busy} onClick={() => void chooseFile()}>이미지 파일 선택</Button>
        <Button disabled={busy || privacyMode} onClick={() => void loadFrames()}>영상에서 고르기</Button>
        <Button disabled={busy} variant="ghost" onClick={() => void run(() => gateway.resetPrivateVaultThumbnail!(asset.id))}>기본 썸네일로 복원</Button>
      </div>
      {candidates.length > 0 && !privacyMode && <div className="external-vault-thumbnail-editor__frames" aria-label="영상 프레임 후보">
        {candidates.map((candidate) => <button key={candidate.timestampMs} type="button" disabled={busy}
          onClick={() => void run(() => gateway.setPrivateVaultThumbnailFromFrame!(asset.id, candidate.timestampMs))}>
          <img src={candidate.url} alt={`${formatTimestamp(candidate.timestampMs)} 프레임`} />
          <span>{formatTimestamp(candidate.timestampMs)}</span>
        </button>)}
      </div>}
    </div>
    {error && <p className="external-vault-editor__error" role="alert">{error}</p>}
    <div className="ui-dialog__actions"><Button disabled={busy} onClick={onClose}>닫기</Button></div>
  </Dialog>;
}

function toAssetSummary(asset: PrivateVaultAssetSummary): AssetSummary {
  const title = asset.title ?? null;
  return {
    id: asset.id, title, originalName: asset.originalName, byteSize: asset.byteSize, width: asset.width, height: asset.height,
    collectedAt: asset.modifiedAt, favorite: false, sourceUrl: null, sourcePublishedAt: null,
    creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null,
    importBatchId: null, originalModifiedAt: asset.modifiedAt,
    media: asset.media.kind === "video" ? { ...asset.media, preparationState: "ready", scrubFrameCount: 0 } : asset.media,
  };
}

function formatTimestamp(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
