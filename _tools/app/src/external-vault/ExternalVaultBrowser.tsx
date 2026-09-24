import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AssetGallery } from "../assets/AssetGallery";
import { AssetViewer } from "../assets/AssetViewer";
import { commandErrorMessage } from "../library/errorMessage";
import type {
  AssetSummary, EncryptedVaultImportReport, EncryptedVaultItem,
  EncryptedVaultItemKind, EncryptedVaultStatus, LibraryGateway,
} from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { TextField } from "../shared/ui/TextField";
import { vaultErrorMessage } from "./vaultErrors";
import { dismissVaultImport, reattachVaultImport, startVaultImport, useVaultImportJob, vaultImportProgressText } from "./vaultImportJob";
import "./externalVault.css";

type Filter = "all" | EncryptedVaultItemKind;
const PAGE_SIZE = 80;
/** While an import runs, the first page refreshes at most this often. */
const LIVE_REFRESH_MS = 2_000;

type Props = {
  gateway: LibraryGateway;
  status: EncryptedVaultStatus;
  onStatusChange: (status: EncryptedVaultStatus) => void;
  onContentChanged?: () => void;
  privacyMode?: boolean;
};

/** The 비밀 view: an unlock panel while locked, the encrypted gallery while unlocked. */
export function ExternalVaultBrowser({ gateway, status, onStatusChange, onContentChanged, privacyMode = false }: Props) {
  return status.state === "unlocked"
    ? <VaultGallery gateway={gateway} onStatusChange={onStatusChange} onContentChanged={onContentChanged} privacyMode={privacyMode} />
    : <VaultUnlockPanel gateway={gateway} remembered={status.remembered} onStatusChange={onStatusChange} />;
}

function VaultUnlockPanel({ gateway, remembered, onStatusChange }: { gateway: LibraryGateway; remembered: boolean; onStatusChange: (status: EncryptedVaultStatus) => void }) {
  const [kind, setKind] = useState<"password" | "recoveryKey">("password");
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (busy || !value || !gateway.unlockEncryptedVault) return;
    setBusy(true);
    setError(null);
    try {
      const next = await gateway.unlockEncryptedVault({ kind, value: kind === "recoveryKey" ? value.trim() : value }, remember);
      setValue("");
      onStatusChange(next);
    } catch (cause) {
      setError(vaultErrorMessage(cause, kind, "비밀 보관함을 열지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }
  const recovery = kind === "recoveryKey";
  return <section className="external-vault-unlock" aria-label="비밀">
    <form className="external-vault-unlock__form" onSubmit={(event) => void unlock(event)}>
      <h2>비밀 보관함이 잠겨 있습니다</h2>
      <p>{recovery ? "보관함을 만들 때 받은 64자리 복구키를 입력하세요." : remembered ? "이 PC에 기억한 키로 열지 못했습니다. 비밀번호를 입력하세요." : "비밀번호를 입력하면 보관함을 엽니다."}</p>
      <TextField key={kind} autoFocus type={recovery ? "text" : "password"} label={recovery ? "복구키" : "비밀번호"}
        autoComplete="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} />
      <label className="external-vault-check">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />이 PC에서 기억
      </label>
      {error && <p className="external-vault-message external-vault-message--error" role="alert">{error}</p>}
      <div className="external-vault-actions">
        <Button type="submit" variant="primary" disabled={busy || !value}>{busy ? "여는 중…" : "열기"}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setKind(recovery ? "password" : "recoveryKey"); setValue(""); setError(null); }}>
          {recovery ? "비밀번호로 열기" : "복구키로 열기"}
        </Button>
      </div>
    </form>
  </section>;
}

function VaultGallery({ gateway, onStatusChange, onContentChanged, privacyMode }: { gateway: LibraryGateway; onStatusChange: (status: EncryptedVaultStatus) => void; onContentChanged?: () => void; privacyMode: boolean }) {
  const listItems = gateway.listEncryptedVaultItems!;
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [titleEditorOpen, setTitleEditorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { job: importJob, completions } = useVaultImportJob();
  const importing = Boolean(importJob?.running);
  const [locking, setLocking] = useState(false);
  const kind = filter === "all" ? null : filter;

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listItems({ kind, offset: 0, limit: PAGE_SIZE });
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
  }, [kind, listItems]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);
  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [items, selectedId]);

  const loadNext = useCallback(async () => {
    if (nextOffset === null) return;
    try {
      const page = await listItems({ kind, offset: nextOffset, limit: PAGE_SIZE });
      setItems((current) => [...current, ...page.items.map(toAssetSummary)]);
      setNextOffset(page.nextOffset);
      setTotalCount(page.totalCount);
    } catch (cause) {
      setError(commandErrorMessage(cause, "다음 항목을 불러오지 못했습니다."));
    }
  }, [kind, listItems, nextOffset]);

  // The import lives outside this view; refresh when one ends (also one that ended while
  // the view was closed is already in the first load) and, while it runs, the first page.
  const seenCompletions = useRef(completions);
  useEffect(() => {
    if (seenCompletions.current === completions) return;
    seenCompletions.current = completions;
    onContentChanged?.();
    void loadFirst();
  }, [completions, loadFirst, onContentChanged]);
  const lastLiveRefresh = useRef(Date.now());
  const liveRefreshAllowed = useRef(true);
  liveRefreshAllowed.current = items.length <= PAGE_SIZE && viewerId === null;
  const importedSoFar = importJob?.running ? importJob.progress?.imported ?? 0 : 0;
  useEffect(() => {
    if (importedSoFar === 0) return;
    const timer = window.setTimeout(() => {
      if (!liveRefreshAllowed.current) return;
      lastLiveRefresh.current = Date.now();
      void loadFirst();
    }, Math.max(0, lastLiveRefresh.current + LIVE_REFRESH_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [importedSoFar, loadFirst]);

  async function importFolder() {
    if (importing || !gateway.importIntoEncryptedVault) return;
    setError(null);
    if (await reattachVaultImport(gateway)) return;
    let folder: string | string[] | null;
    try { folder = await open({ directory: true, multiple: false, title: "비밀 보관함으로 가져올 폴더" }); }
    catch (cause) { setError(commandErrorMessage(cause, "폴더를 선택하지 못했습니다.")); return; }
    if (typeof folder !== "string") return;
    dismissVaultImport();
    await startVaultImport(gateway, folder);
  }

  async function lock() {
    if (!gateway.lockEncryptedVault) return;
    setLocking(true);
    setError(null);
    try {
      setViewerId(null);
      onStatusChange(await gateway.lockEncryptedVault());
    } catch (cause) {
      setError(commandErrorMessage(cause, "비밀 보관함을 잠그지 못했습니다."));
      setLocking(false);
    }
  }

  const active = useMemo(() => items.some((item) => item.id === viewerId) ? viewerId : null, [items, viewerId]);
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const selectedAssetIds = useMemo(() => selectedId ? new Set([selectedId]) : new Set<string>(), [selectedId]);

  return <section className="external-vault-browser" aria-label="비밀">
    <header className="external-vault-browser__toolbar">
      <div className="external-vault-browser__filters" role="group" aria-label="미디어 필터">
        {(["all", "image", "video"] as const).map((value) => <Button key={value} size="sm"
          variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value}
          onClick={() => setFilter(value)}>{{ all: "전체", image: "이미지", video: "영상" }[value]}</Button>)}
      </div>
      <div className="external-vault-browser__actions">
        <Button size="sm" variant="ghost" disabled={!selected} onClick={() => setTitleEditorOpen(true)}>제목 변경</Button>
        <Button size="sm" variant="ghost" disabled={importing || !gateway.importIntoEncryptedVault} onClick={() => void importFolder()}>{importing ? "가져오는 중…" : "가져오기"}</Button>
        <Button size="sm" variant="ghost" disabled={importing || locking} onClick={() => void lock()}>잠그기</Button>
      </div>
    </header>
    {importJob?.running && <div className="external-vault-browser__progress" role="status">
      <span>{vaultImportProgressText(importJob)}</span>
      <progress aria-label="가져오기 진행률" max={importJob.progress?.total || undefined} value={importJob.progress?.total ? importJob.progress.processed : undefined} />
    </div>}
    {error && <p className="external-vault-browser__error" role="alert">{error}</p>}
    {importJob?.error && <p className="external-vault-browser__error" role="alert">
      {importJob.error} <Button size="sm" variant="ghost" onClick={dismissVaultImport}>닫기</Button>
    </p>}
    {!loading && items.length === 0
      ? <EmptyState title="비밀 보관함이 비어 있습니다"><p>가져오기로 PC 폴더의 이미지와 영상을 암호화해 넣을 수 있습니다.</p></EmptyState>
      : <AssetGallery items={items} layout="masonry" scopeKey={`external-vault:${filter}`} totalCount={totalCount}
          mediaSource="vault" metadataVisible={!privacyMode} captionLabel={(asset) => asset.title || asset.originalName}
          privacyMode={privacyMode}
          selectedAssetIds={selectedAssetIds} focusAssetId={selectedId}
          onSelectionGesture={(asset) => setSelectedId(asset.id)} onClearSelection={() => setSelectedId(null)}
          hasNextPage={nextOffset !== null} onLoadNextPage={() => void loadNext()}
          onOpen={(asset) => setViewerId(asset.id)} />}
    {active && <AssetViewer items={items} activeId={active} onActiveIdChange={setViewerId} onClose={() => setViewerId(null)} privacyMode={privacyMode} mediaSource="vault" />}
    {titleEditorOpen && selected && <TitleEditor asset={selected} gateway={gateway}
      onClose={() => setTitleEditorOpen(false)} onChanged={() => void loadFirst()} />}
    {importJob?.report && !importJob.running && <ImportReportDialog report={importJob.report} onClose={dismissVaultImport} />}
  </section>;
}

function TitleEditor({ asset, gateway, onClose, onChanged }: { asset: AssetSummary; gateway: LibraryGateway; onClose(): void; onChanged(): void }) {
  const [title, setTitle] = useState(asset.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (!gateway.setEncryptedVaultTitle) return;
    setBusy(true); setError(null);
    try {
      await gateway.setEncryptedVaultTitle(asset.id, title.trim() || null);
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

function ImportReportDialog({ report, onClose }: { report: EncryptedVaultImportReport; onClose(): void }) {
  const rows: Array<[string, number]> = [
    ["가져옴", report.imported],
    ["이미 있음 (같은 내용 확인)", report.skipped],
    ["실패", report.failed],
    ["영상 썸네일로 적용", report.sidecarThumbnails ?? 0],
    ["영상 썸네일 파일 건너뜀 (이미 썸네일 있음)", report.sidecarSkipped ?? 0],
    ["썸네일 없음", report.withoutThumbnail],
    ["이전 보관함 제목", report.legacyTitles],
    ["이전 보관함 썸네일", report.legacyThumbnails],
  ];
  return <Dialog open title="가져오기 완료" onClose={onClose}>
    <dl className="external-vault-report">
      {rows.filter(([, value], index) => index < 3 || value > 0).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value.toLocaleString()}개</dd></div>)}
    </dl>
    <p className="external-vault-editor__hint">원본 파일은 PC에 그대로 남아 있습니다. 원본을 지우기 전에 보관함에서 파일이 열리는지 확인하세요.</p>
    {report.failed > 0 && <p className="external-vault-editor__hint">실패한 파일은 보관함에 없습니다. 이 파일의 원본은 지우지 마세요.</p>}
    <div className="ui-dialog__actions"><Button variant="primary" onClick={onClose}>닫기</Button></div>
  </Dialog>;
}

const FALLBACK_SIZE = { image: [1600, 1200], video: [1920, 1080] } as const;

function toAssetSummary(item: EncryptedVaultItem): AssetSummary {
  const [fallbackWidth, fallbackHeight] = FALLBACK_SIZE[item.kind];
  return {
    id: item.id, title: item.title, originalName: item.originalFileName, byteSize: item.byteSize,
    width: item.width || fallbackWidth, height: item.height || fallbackHeight,
    collectedAt: item.importedAt, favorite: false, sourceUrl: null, sourcePublishedAt: null,
    creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null,
    importBatchId: null, originalModifiedAt: item.importedAt,
    media: item.kind === "video"
      ? { kind: "video", durationMs: 0, preparationState: "ready", scrubFrameCount: 0 }
      : { kind: "image" },
  };
}
