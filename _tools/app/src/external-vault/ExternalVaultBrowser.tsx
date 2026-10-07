import { useDelayedBusy } from "../shared/useDelayedBusy";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AssetGallery } from "../assets/AssetGallery";
import { AssetViewer } from "../assets/AssetViewer";
import { applySelectionGesture, emptySelection, moveSelectionFocus, reconcileSelection, selectAllLoaded, type SelectionGesture, type SelectionState } from "../assets/selection";
import { commandErrorMessage } from "../library/errorMessage";
import type {
  AssetSummary, EncryptedVaultFolder, EncryptedVaultImportReport, EncryptedVaultItem,
  EncryptedVaultItemKind, EncryptedVaultStatus, LibraryGateway,
} from "../library/types";
import { ArrowRightCircleIcon, ArrowUpTrayIcon, ArrowUturnLeftIcon, DocumentPlusIcon, FilmIcon, FolderArrowDownIcon, LockClosedIcon, PencilIcon, PhotoIcon, Squares2X2Icon, TrashIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { ChromeContribution } from "../layout/WorkspaceChrome";
import { pointerDragReducer, type InternalDragPayload, type PointerDragAction, type PointerDragState } from "../shared/interaction/pointerDrag";
import { VaultFolderPicker, VaultFolderSidebar, type VaultDropTarget, type VaultScope } from "./VaultFolderSidebar";
import type { ComponentType, SVGProps } from "react";
import { Button } from "../shared/ui/Button";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { TextField } from "../shared/ui/TextField";
import { Toast } from "../shared/ui/Toast";
import { vaultErrorMessage } from "./vaultErrors";
import { dismissVaultExport, reattachVaultExport, startVaultExport, useVaultExportJob, vaultExportProgressText, vaultExportResultText } from "./vaultExportJob";
import { dismissVaultImport, reattachVaultImport, startVaultFileImport, startVaultImport, useVaultImportJob, vaultImportProgressText } from "./vaultImportJob";
import "./externalVault.css";

type Filter = "all" | EncryptedVaultItemKind | "trash";
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
    ? <VaultGallery gateway={gateway} status={status} onStatusChange={onStatusChange} onContentChanged={onContentChanged} privacyMode={privacyMode} />
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
        <Button type="submit" variant="primary" disabled={busy || !value}><BusyLabel busy={!!(busy)} idle={"열기"}>여는 중…</BusyLabel></Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setKind(recovery ? "password" : "recoveryKey"); setValue(""); setError(null); }}>
          {recovery ? "비밀번호로 열기" : "복구키로 열기"}
        </Button>
      </div>
    </form>
  </section>;
}

function VaultGallery({ gateway, status, onStatusChange, onContentChanged, privacyMode }: { gateway: LibraryGateway; status: EncryptedVaultStatus; onStatusChange: (status: EncryptedVaultStatus) => void; onContentChanged?: () => void; privacyMode: boolean }) {
  const listItems = gateway.listEncryptedVaultItems!;
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<VaultScope>({ kind: "all" });
  const [folders, setFolders] = useState<EncryptedVaultFolder[]>([]);
  const [folderDialog, setFolderDialog] = useState<FolderDialog | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [dragState, setDragState] = useState<PointerDragState>({ phase: "idle" });
  const dragStateRef = useRef<PointerDragState>({ phase: "idle" });
  const [dropTarget, setDropTarget] = useState<VaultDropTarget>(null);
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [itemFolders, setItemFolders] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const [titleEditorOpen, setTitleEditorOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [message, setMessage] = useState<{ text: string; undoIds?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { job: importJob, completions } = useVaultImportJob();
  const exportJob = useVaultExportJob();
  const importing = Boolean(importJob?.running);
  const showImporting = useDelayedBusy(importing);
  const exporting = Boolean(exportJob?.running);
  const showExporting = useDelayedBusy(exporting);
  const [locking, setLocking] = useState(false);
  const trashView = filter === "trash";
  const kind = filter === "image" || filter === "video" ? filter : null;
  const trashedCount = status.trashedCount ?? null;
  /** Opened from the backup index: viewing and export only; the backend refuses every change. */
  const readOnly = Boolean(status.backupIndex);
  const foldersSupported = Boolean(gateway.listEncryptedVaultFolders);
  const scopeKey = scope.kind === "folder" ? `folder:${scope.folderId}` : scope.kind;

  const loadFolders = useCallback(async () => {
    if (!gateway.listEncryptedVaultFolders) return;
    try {
      const next = await gateway.listEncryptedVaultFolders();
      setFolders(next);
      setScope((current) => current.kind === "folder" && !next.some((folder) => folder.id === current.folderId) ? { kind: "all" } : current);
    } catch (cause) {
      setError(commandErrorMessage(cause, "폴더 목록을 불러오지 못했습니다."));
    }
  }, [gateway]);
  useEffect(() => { void loadFolders(); }, [loadFolders]);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listItems({ kind, offset: 0, limit: PAGE_SIZE, ...scopeFilter(scope, trashView) });
      setItems(page.items.map(toAssetSummary));
      setItemFolders(new Map(page.items.map((item) => [item.id, item.folderId ?? null])));
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
  }, [kind, listItems, trashView, scope]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);
  const itemIds = useMemo(() => items.map((item) => item.id), [items]);
  useEffect(() => { setSelection((current) => reconcileSelection(current, itemIds)); }, [itemIds]);

  const loadNext = useCallback(async () => {
    if (nextOffset === null) return;
    try {
      const page = await listItems({ kind, offset: nextOffset, limit: PAGE_SIZE, ...scopeFilter(scope, trashView) });
      setItems((current) => [...current, ...page.items.map(toAssetSummary)]);
      setItemFolders((current) => new Map([...current, ...page.items.map((item) => [item.id, item.folderId ?? null] as const)]));
      setNextOffset(page.nextOffset);
      setTotalCount(page.totalCount);
    } catch (cause) {
      setError(commandErrorMessage(cause, "다음 항목을 불러오지 못했습니다."));
    }
  }, [kind, listItems, nextOffset, trashView, scope]);

  // Videos imported before lengths were recorded show "—"; measure them a few at a time in the
  // background and patch the shown tiles in place. The backend skips videos it could not read.
  const durationFill = useRef<"idle" | "running" | "done">("idle");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const needsDurations = !readOnly && Boolean(gateway.fillEncryptedVaultVideoDurations)
    && items.some((item) => item.media.kind === "video" && !item.media.durationMs);
  useEffect(() => {
    const fill = gateway.fillEncryptedVaultVideoDurations;
    if (!needsDurations || !fill || durationFill.current !== "idle") return;
    durationFill.current = "running";
    void (async () => {
      try {
        let previous = Number.POSITIVE_INFINITY;
        while (mounted.current) {
          const step = await fill();
          if (!mounted.current) break;
          if (step.filled.length > 0) {
            const lengths = new Map(step.filled.map((entry) => [entry.id, entry.durationMs]));
            setItems((current) => current.map((item) => item.media.kind === "video" && lengths.has(item.id)
              ? { ...item, media: { ...item.media, durationMs: lengths.get(item.id)! } }
              : item));
          }
          // Each step fills or gives up on its videos, so `remaining` shrinks; stop if it does not.
          if (step.remaining === 0 || step.remaining >= previous) break;
          previous = step.remaining;
        }
      } catch {
        // Lengths are a convenience; the tiles keep showing "—".
      }
      durationFill.current = mounted.current ? "done" : "idle";
    })();
  }, [gateway, needsDurations]);

  // The import lives outside this view; refresh when one ends (also one that ended while
  // the view was closed is already in the first load) and, while it runs, the first page.
  const seenCompletions = useRef(completions);
  useEffect(() => {
    if (seenCompletions.current === completions) return;
    seenCompletions.current = completions;
    onContentChanged?.();
    void loadFirst();
    void loadFolders();
  }, [completions, loadFirst, loadFolders, onContentChanged]);
  const lastLiveRefresh = useRef(Date.now());
  const liveRefreshAllowed = useRef(true);
  liveRefreshAllowed.current = items.length <= PAGE_SIZE && viewerId === null && !trashView;
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

  function changeFilter(next: Filter) {
    setFilter(next);
    setSelection(emptySelection());
    setViewerId(null);
    setConfirm(null);
  }

  function changeScope(next: VaultScope) {
    setScope(next);
    if (trashView) setFilter("all");
    setSelection(emptySelection());
    setViewerId(null);
    setConfirm(null);
  }

  /** Runs a folder command; returns an error message (shown inline) or null. */
  async function folderCommand(action: () => Promise<unknown>, fallback: string) {
    try {
      await action();
      await loadFolders();
      return null;
    } catch (cause) {
      return vaultChangeErrorMessage(cause, fallback);
    }
  }

  async function createFolder(name: string, parentId: string | null) {
    const call = gateway.createEncryptedVaultFolder;
    if (!call) return null;
    return folderCommand(() => call(name, parentId), "폴더를 만들지 못했습니다.");
  }

  async function renameFolder(folderId: string, name: string) {
    const call = gateway.renameEncryptedVaultFolder;
    if (!call) return null;
    return folderCommand(() => call(folderId, name), "폴더 이름을 바꾸지 못했습니다.");
  }

  async function deleteFolder(folder: EncryptedVaultFolder) {
    const call = gateway.deleteEncryptedVaultFolder;
    if (!call || readOnly) return;
    setError(null);
    const failure = await folderCommand(() => call(folder.id), "폴더를 삭제하지 못했습니다.");
    if (failure) { setError(failure); return; }
    if (scope.kind === "folder" && scope.folderId === folder.id) changeScope(folder.parentId ? { kind: "folder", folderId: folder.parentId } : { kind: "all" });
    else void loadFirst();
    setMessage({ text: folder.itemCount > 0
      ? `'${folder.name}' 폴더를 삭제했습니다. 안의 ${folder.itemCount.toLocaleString()}개는 ${folder.parentId ? "상위 폴더로" : "미분류로"} 옮겼습니다.`
      : `'${folder.name}' 폴더를 삭제했습니다.` });
  }

  async function moveFolder(folderId: string, parentId: string | null) {
    const call = gateway.moveEncryptedVaultFolder;
    if (!call) return;
    setBusy(true);
    setFolderError(null);
    const failure = await folderCommand(() => call(folderId, parentId), "폴더를 옮기지 못했습니다.");
    setBusy(false);
    if (failure) { setFolderError(failure); return; }
    setFolderDialog(null);
    void loadFirst();
  }

  /** Puts items in a folder (`null`: out of every folder) and refreshes what this view shows. */
  async function moveItemsToFolder(ids: string[], folderId: string | null) {
    const call = gateway.moveEncryptedVaultItemsToFolder;
    if (!call || readOnly || busy || ids.length === 0) return false;
    setBusy(true);
    setError(null);
    setFolderError(null);
    try {
      const count = await call(ids, folderId);
      const target = folderId === null ? "미분류" : `'${folders.find((folder) => folder.id === folderId)?.name ?? "폴더"}'`;
      setMessage({ text: count > 0 ? `${count.toLocaleString()}개를 ${target}${folderId === null ? "로" : " 폴더로"} 옮겼습니다.` : "이미 그 폴더에 있습니다." });
      setSelection(emptySelection());
      await Promise.all([loadFolders(), loadFirst()]);
      return true;
    } catch (cause) {
      const failure = vaultChangeErrorMessage(cause, "폴더로 옮기지 못했습니다.");
      if (folderDialog) setFolderError(failure); else setError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function transitionDrag(action: PointerDragAction) {
    const next = pointerDragReducer(dragStateRef.current, action);
    dragStateRef.current = next;
    setDragState(next);
    return next;
  }

  /** Vault items move only between vault folders: never a native drag out (it would write plaintext). */
  function dropTargetAt(x: number, y: number): VaultDropTarget {
    const element = document.elementFromPoint?.(x, y)?.closest<HTMLElement>("[data-vault-folder-id]");
    if (!element) return null;
    const folderId = element.dataset.vaultFolderId ?? "";
    return { folderId: folderId === "" ? null : folderId };
  }

  const galleryDrag = foldersSupported && !trashView && !readOnly ? {
    onPointerDragStart: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => {
      if (payload.kind !== "assets") return;
      transitionDrag({ type: "arm", payload, x: event.clientX, y: event.clientY });
      setDropTarget(null);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerDragMove: (event: React.PointerEvent<HTMLElement>) => {
      const next = transitionDrag({ type: "move", x: event.clientX, y: event.clientY });
      if (next.phase !== "dragging") return;
      event.preventDefault();
      setDropTarget(dropTargetAt(event.clientX, event.clientY));
    },
    onPointerDragEnd: (event: React.PointerEvent<HTMLElement>) => {
      const current = dragStateRef.current;
      const target = current.phase === "dragging" ? dropTargetAt(event.clientX, event.clientY) : null;
      transitionDrag({ type: "finish" });
      setDropTarget(null);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (target && current.phase === "dragging" && current.payload.kind === "assets") void moveItemsToFolder(current.payload.assetIds, target.folderId);
    },
    onPointerDragCancel: (event: React.PointerEvent<HTMLElement>) => {
      transitionDrag({ type: "cancel" });
      setDropTarget(null);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
  } : {};
  useEffect(() => {
    document.body.classList.toggle("is-pointer-dragging", dragState.phase === "dragging");
    return () => document.body.classList.remove("is-pointer-dragging");
  }, [dragState.phase]);

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

  async function addFiles() {
    if (importing || !gateway.importFilesIntoEncryptedVault) return;
    setError(null);
    if (await reattachVaultImport(gateway)) return;
    let picked: string | string[] | null;
    try {
      picked = await open({ directory: false, multiple: true, title: "비밀 보관함에 추가할 파일", filters: [{ name: "이미지와 영상", extensions: MEDIA_EXTENSIONS }] });
    } catch (cause) { setError(commandErrorMessage(cause, "파일을 선택하지 못했습니다.")); return; }
    const files = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (files.length === 0) return;
    dismissVaultImport();
    await startVaultFileImport(gateway, files);
  }

  async function exportItems(ids: string[]) {
    if (ids.length === 0 || exporting || !gateway.exportEncryptedVaultItems) return;
    setError(null);
    if (await reattachVaultExport(gateway)) return;
    let folder: string | string[] | null;
    try { folder = await open({ directory: true, multiple: false, title: "내보낼 PC 폴더" }); }
    catch (cause) { setError(commandErrorMessage(cause, "폴더를 선택하지 못했습니다.")); return; }
    if (typeof folder !== "string") return;
    dismissVaultExport();
    await startVaultExport(gateway, ids, folder);
  }

  /** Runs a trash/restore/delete call, then drops the affected items from this view. */
  async function change(ids: string[] | "all", action: () => Promise<number>, done: (count: number) => void, fallback: string) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const count = await action();
      const gone = ids === "all" ? new Set(itemIds) : new Set(ids);
      const removed = itemIds.filter((id) => gone.has(id)).length;
      setItems((current) => current.filter((item) => !gone.has(item.id)));
      setTotalCount((current) => Math.max(0, current - removed));
      setNextOffset((current) => ids === "all" ? null : current === null ? null : Math.max(0, current - removed));
      setSelection(emptySelection());
      done(count);
      onContentChanged?.();
      void loadFolders();
      return true;
    } catch (cause) {
      setError(vaultChangeErrorMessage(cause, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function trash(ids: string[]) {
    const call = gateway.trashEncryptedVaultItems;
    if (!call || readOnly || ids.length === 0) return Promise.resolve(false);
    return change(ids, () => call(ids), (count) => setMessage({ text: `${count.toLocaleString()}개를 휴지통으로 옮겼습니다.`, undoIds: ids }), "휴지통으로 옮기지 못했습니다.");
  }

  function restore(ids: string[]) {
    const call = gateway.restoreEncryptedVaultItems;
    if (!call || readOnly || ids.length === 0) return;
    void change(ids, () => call(ids), (count) => setMessage({ text: `${count.toLocaleString()}개를 복원했습니다.` }), "복원하지 못했습니다.");
  }

  async function undoTrash(ids: string[]) {
    const call = gateway.restoreEncryptedVaultItems;
    if (!call || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await call(ids);
      onContentChanged?.();
      await loadFirst();
    } catch (cause) {
      setError(commandErrorMessage(cause, "복원하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeletion(target: Confirmation) {
    const done = (count: number) => setMessage({ text: `${count.toLocaleString()}개를 영구 삭제했습니다.` });
    const ok = target.kind === "empty"
      ? gateway.emptyEncryptedVaultTrash && await change("all", gateway.emptyEncryptedVaultTrash, done, "휴지통을 비우지 못했습니다.")
      : gateway.deleteEncryptedVaultItems && await change(target.ids, () => gateway.deleteEncryptedVaultItems!(target.ids), done, "영구 삭제하지 못했습니다.");
    if (ok) setConfirm(null);
  }

  async function setThumbnailFromFrame(asset: AssetSummary, timeMs: number) {
    const call = gateway.setEncryptedVaultThumbnailFromFrame;
    if (!call || readOnly || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call(asset.id, timeMs);
      // Vault thumbnails are never cached by the server; a new revision reloads only this item's images.
      const revision = Date.now();
      setItems((current) => current.map((item) => item.id === asset.id ? { ...item, thumbnailRevision: String(revision) } : item));
      setMessage({ text: "이 프레임을 썸네일로 지정했습니다." });
    } catch (cause) {
      setError(vaultChangeErrorMessage(cause, "썸네일을 바꾸지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  function trashFromViewer(asset: AssetSummary) {
    const index = items.findIndex((item) => item.id === asset.id);
    const neighbor = items[index + 1] ?? items[index - 1] ?? null;
    void trash([asset.id]).then((ok) => { if (ok) setViewerId(neighbor?.id ?? null); });
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
  const selectedIds = itemIds.filter((id) => selection.ids.has(id));
  const single = selectedIds.length === 1 ? items.find((item) => item.id === selectedIds[0]) ?? null : null;
  const selectWithGesture = (asset: AssetSummary, gesture: SelectionGesture) =>
    setSelection((current) => applySelectionGesture(current, itemIds, asset.id, gesture));
  const askDelete = (ids: string[]) => { if (ids.length > 0 && !readOnly) setConfirm({ kind: "delete", ids }); };
  const selectedLabel = selectedIds.length > 0 ? ` ${selectedIds.length.toLocaleString()}개` : "";
  function openMoveItems(ids: string[]) {
    if (ids.length === 0 || readOnly) return;
    const current = new Set(ids.map((id) => itemFolders.get(id) ?? null));
    setFolderError(null);
    setFolderDialog({ kind: "items", ids, currentId: current.size === 1 ? [...current][0] : undefined });
  }

  const contextItems: ContextMenuItem[] = trashView
    ? [
      { id: "restore", label: "복원", disabled: busy || readOnly, onSelect: () => restore(selectedIds) },
      { id: "delete", label: "영구 삭제", destructive: true, disabled: busy || readOnly, onSelect: () => askDelete(selectedIds) },
    ]
    : [
      { id: "export", label: "내보내기", disabled: exporting, onSelect: () => void exportItems(selectedIds) },
      ...(foldersSupported ? [{ id: "move", label: "폴더로 이동…", disabled: busy || readOnly, onSelect: () => openMoveItems(selectedIds) }] : []),
      { id: "title", label: "제목 변경", disabled: !single || readOnly, onSelect: () => setTitleEditorOpen(true) },
      { id: "trash", label: "휴지통으로", destructive: true, disabled: busy || readOnly, onSelect: () => void trash(selectedIds) },
    ];

  return <section className="external-vault-browser" aria-label="비밀">
    {foldersSupported && <ChromeContribution title="비밀" spec={{ navigation: <VaultFolderSidebar folders={folders} scope={trashView ? { kind: "all" } : scope} onScopeChange={changeScope}
      totalCount={status.itemCount ?? null} readOnly={readOnly} dropTarget={dropTarget} onCreate={createFolder} onRename={renameFolder}
      onDelete={(folder) => void deleteFolder(folder)} onMove={(folder) => { setFolderError(null); setFolderDialog({ kind: "folder", folder }); }} /> }} />}
    <header className="external-vault-browser__toolbar">
      <div className="external-vault-browser__filters" role="group" aria-label="미디어 필터">
        {(["all", "image", "video"] as const).map((value) => {
          const { label, Icon } = { all: { label: "전체", Icon: Squares2X2Icon }, image: { label: "이미지", Icon: PhotoIcon }, video: { label: "영상", Icon: FilmIcon } }[value];
          return <Button key={value} size="icon" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value}
            aria-label={label} title={label} onClick={() => changeFilter(value)}><Icon aria-hidden="true" /></Button>;
        })}
        <span className="external-vault-browser__divider" aria-hidden="true" />
        <Button size="sm" className="external-vault-browser__icon-count" variant={trashView ? "secondary" : "ghost"} aria-pressed={trashView} onClick={() => changeFilter("trash")}
          aria-label={trashedCount ? `휴지통 ${trashedCount.toLocaleString()}` : "휴지통"} title="휴지통">
          <TrashIcon aria-hidden="true" />{trashedCount ? <span className="external-vault-browser__count" aria-hidden="true">{trashedCount.toLocaleString()}</span> : null}
        </Button>
      </div>
      <div className="external-vault-browser__actions">
        {trashView ? <>
          <ToolbarAction label={`복원${selectedLabel}`} title="복원" count={selectedIds.length} Icon={ArrowUturnLeftIcon} disabled={busy || readOnly || selectedIds.length === 0} onClick={() => restore(selectedIds)} />
          <ToolbarAction label={`영구 삭제${selectedLabel}`} title="영구 삭제" count={selectedIds.length} Icon={XCircleIcon} disabled={busy || readOnly || selectedIds.length === 0} onClick={() => askDelete(selectedIds)} />
          <ToolbarAction label="휴지통 비우기" Icon={TrashIcon} disabled={busy || readOnly || (totalCount === 0 && !trashedCount)} onClick={() => setConfirm({ kind: "empty" })} />
        </> : <>
          {selectedIds.length > 0 && <>
            <ToolbarAction label={showExporting ? "내보내는 중…" : `내보내기${selectedLabel}`} title="PC로 내보내기" count={exporting ? 0 : selectedIds.length} Icon={ArrowUpTrayIcon} disabled={exporting || !gateway.exportEncryptedVaultItems} onClick={() => void exportItems(selectedIds)} />
            {foldersSupported && <ToolbarAction label={`폴더로 이동${selectedLabel}`} title="폴더로 이동" Icon={ArrowRightCircleIcon} disabled={busy || readOnly} onClick={() => openMoveItems(selectedIds)} />}
            <ToolbarAction label="휴지통으로" Icon={TrashIcon} disabled={busy || readOnly || !gateway.trashEncryptedVaultItems} onClick={() => void trash(selectedIds)} />
          </>}
          <ToolbarAction label="제목 변경" Icon={PencilIcon} disabled={!single || readOnly} onClick={() => setTitleEditorOpen(true)} />
          <span className="external-vault-browser__divider" aria-hidden="true" />
          <ToolbarAction label="파일 추가" Icon={DocumentPlusIcon} disabled={importing || readOnly || !gateway.importFilesIntoEncryptedVault} onClick={() => void addFiles()} />
          <ToolbarAction label={showImporting ? "가져오는 중…" : "가져오기"} title="폴더 가져오기" Icon={FolderArrowDownIcon} disabled={importing || readOnly || !gateway.importIntoEncryptedVault} onClick={() => void importFolder()} />
        </>}
        <span className="external-vault-browser__divider" aria-hidden="true" />
        <ToolbarAction label="잠그기" Icon={LockClosedIcon} disabled={importing || locking} onClick={() => void lock()} />
      </div>
    </header>
    {importJob?.running && <div className="external-vault-browser__progress" role="status">
      <span>{vaultImportProgressText(importJob)}</span>
      <progress aria-label="가져오기 진행률" max={importJob.progress?.total || undefined} value={importJob.progress?.total ? importJob.progress.processed : undefined} />
    </div>}
    {exportJob && <div className="external-vault-browser__progress" role={exportJob.error ? "alert" : "status"}>
      <span>{exportJob.running ? vaultExportProgressText(exportJob) : `내보내기 ${vaultExportResultText(exportJob)}`}</span>
      {exportJob.running
        ? <progress aria-label="내보내기 진행률" max={exportJob.progress?.total || undefined} value={exportJob.progress?.total ? exportJob.progress.processed : undefined} />
        : <Button size="sm" variant="ghost" onClick={dismissVaultExport}>닫기</Button>}
    </div>}
    {readOnly && <p className="external-vault-browser__hint" role="status">보관함 목록이 손상되어 이전 백업본으로 읽기 전용으로 열었습니다. 최근에 넣거나 바꾼 항목은 보이지 않을 수 있고, 보기와 내보내기만 할 수 있습니다.</p>}
    {trashView && !readOnly && totalCount > 0 && <p className="external-vault-browser__hint">휴지통의 항목은 직접 비울 때까지 USB에 암호화된 채로 남아 있습니다.</p>}
    {error && <p className="external-vault-browser__error" role="alert">{error}</p>}
    {importJob?.error && <p className="external-vault-browser__error" role="alert">
      {importJob.error} <Button size="sm" variant="ghost" onClick={dismissVaultImport}>닫기</Button>
    </p>}
    {!loading && items.length === 0
      ? trashView
        ? <EmptyState title="휴지통이 비어 있습니다"><p>휴지통으로 옮긴 항목은 여기서 복원하거나 영구 삭제할 수 있습니다.</p></EmptyState>
        : <EmptyState title="비밀 보관함이 비어 있습니다"><p>가져오기나 파일 추가로 PC의 이미지와 영상을 암호화해 넣을 수 있습니다.</p></EmptyState>
      : <ContextMenu items={contextItems}><div className="external-vault-browser__results" onContextMenu={(event) => {
          const id = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]")?.dataset.assetId;
          const target = items.find((item) => item.id === id);
          if (!target) { event.preventDefault(); return; }
          if (!selection.ids.has(target.id)) selectWithGesture(target, { toggle: false, range: false });
        }}>
        <AssetGallery items={items} layout="masonry" scopeKey={`external-vault:${filter}:${scopeKey}`} totalCount={totalCount}
          mediaSource="vault" metadataVisible={!privacyMode} captionLabel={(asset) => asset.title || asset.originalName}
          privacyMode={privacyMode}
          selectedAssetIds={selection.ids} focusAssetId={selection.focusId}
          onSelectionGesture={selectWithGesture}
          onSelectAll={() => setSelection((current) => selectAllLoaded(current, itemIds))}
          onMoveFocus={(delta, extend) => setSelection((current) => moveSelectionFocus(current, itemIds, delta, extend))}
          onDeleteSelection={() => { if (readOnly) return; if (trashView) askDelete(selectedIds); else void trash(selectedIds); }}
          onClearSelection={() => setSelection(emptySelection())}
          hasNextPage={nextOffset !== null} onLoadNextPage={() => void loadNext()}
          onOpen={(asset) => setViewerId(asset.id)} {...galleryDrag} />
      </div></ContextMenu>}
    {dragState.phase === "dragging" && dragState.payload.kind === "assets" && <div className="ui-drag-layer" style={{ transform: `translate(${dragState.x + 12}px, ${dragState.y + 12}px)` }} aria-hidden="true">
      {`${dragState.payload.assetIds.length.toLocaleString()}개 · 폴더로 이동`}
    </div>}
    {folderDialog?.kind === "items" && <VaultFolderPicker title={`${folderDialog.ids.length.toLocaleString()}개를 폴더로 이동`} folders={folders} currentId={folderDialog.currentId ?? null}
      noneLabel="폴더에서 빼기 (미분류)" busy={busy} error={folderError} onClose={() => setFolderDialog(null)}
      onPick={(folderId) => void moveItemsToFolder(folderDialog.ids, folderId).then((ok) => { if (ok) setFolderDialog(null); })} />}
    {folderDialog?.kind === "folder" && <VaultFolderPicker title={`'${folderDialog.folder.name}' 폴더 이동`} folders={folders} currentId={folderDialog.folder.parentId}
      excludeId={folderDialog.folder.id} noneLabel="최상위" busy={busy} error={folderError} onClose={() => setFolderDialog(null)}
      onPick={(parentId) => void moveFolder(folderDialog.folder.id, parentId)} />}
    {active && <AssetViewer items={items} activeId={active} onActiveIdChange={setViewerId} onClose={() => setViewerId(null)} privacyMode={privacyMode} mediaSource="vault"
      onTrash={trashView || readOnly || !gateway.trashEncryptedVaultItems ? undefined : trashFromViewer}
      onExport={trashView || !gateway.exportEncryptedVaultItems ? undefined : (asset) => void exportItems([asset.id])}
      onSetVideoThumbnail={trashView || readOnly || !gateway.setEncryptedVaultThumbnailFromFrame ? undefined : (asset, timeMs) => void setThumbnailFromFrame(asset, timeMs)} />}
    {titleEditorOpen && single && !readOnly && <TitleEditor asset={single} gateway={gateway}
      onClose={() => setTitleEditorOpen(false)} onChanged={() => void loadFirst()} />}
    {confirm && <Dialog open title={confirm.kind === "empty" ? "휴지통 비우기" : "영구 삭제"} onClose={() => { if (!busy) setConfirm(null); }}>
      <p className="external-vault-confirm">
        {confirm.kind === "empty"
          ? `휴지통의 ${(trashedCount ?? totalCount).toLocaleString()}개를 USB에서 영구 삭제합니다.`
          : `선택한 ${confirm.ids.length.toLocaleString()}개를 USB에서 영구 삭제합니다.`}
        {" "}되돌릴 수 없습니다. 필요한 파일은 먼저 복원해 내보내세요.
      </p>
      {error && <p className="external-vault-editor__error" role="alert">{error}</p>}
      <div className="ui-dialog__actions">
        <Button disabled={busy} onClick={() => setConfirm(null)}>취소</Button>
        <Button variant="danger" disabled={busy} onClick={() => void confirmDeletion(confirm)}><BusyLabel busy={!!(busy)} idle={"영구 삭제"}>삭제 중…</BusyLabel></Button>
      </div>
    </Dialog>}
    {message && <Toast actionLabel={message.undoIds ? "실행 취소" : undefined} onAction={message.undoIds ? () => void undoTrash(message.undoIds!) : undefined}
      actionDisabled={busy} onDismiss={() => setMessage(null)}>{message.text}</Toast>}
    {importJob?.report && !importJob.running && <ImportReportDialog report={importJob.report} onClose={dismissVaultImport} />}
  </section>;
}

type Confirmation = { kind: "delete"; ids: string[] } | { kind: "empty" };

/** The trash lists every trashed item; folders scope only the gallery. */
function scopeFilter(scope: VaultScope, trashView: boolean) {
  if (trashView) return { trashed: true };
  if (scope.kind === "folder") return { folderId: scope.folderId };
  return scope.kind === "unfiled" ? { unfiledOnly: true } : {};
}
/** `currentId` is undefined when the selected items are in different folders. */
type FolderDialog = { kind: "items"; ids: string[]; currentId?: string | null } | { kind: "folder"; folder: EncryptedVaultFolder };

const MEDIA_EXTENSIONS = ["jpg", "jpeg", "jfif", "png", "webp", "gif", "mp4", "webm", "mov"].flatMap((value) => [value, value.toUpperCase()]);

function vaultChangeErrorMessage(cause: unknown, fallback: string) {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (code === "encrypted_vault_import_running") return "가져오기가 끝난 뒤 영구 삭제할 수 있습니다.";
  if (code === "encrypted_vault_read_only") return "보관함을 이전 백업본으로 읽기 전용으로 열어 지금은 바꿀 수 없습니다.";
  return commandErrorMessage(cause, fallback);
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
      ? { kind: "video", durationMs: item.durationMs ?? 0, preparationState: "ready", scrubFrameCount: 0 }
      : { kind: "image" },
  };
}

/** A toolbar icon button: the accessible name stays the full action (with its count), the tooltip names the action. */
function ToolbarAction({ label, title, Icon, count = 0, disabled, onClick }: { label: string; title?: string; Icon: ComponentType<SVGProps<SVGSVGElement>>; count?: number; disabled?: boolean; onClick: () => void }) {
  return count > 0
    ? <Button size="sm" variant="ghost" className="external-vault-browser__icon-count" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick}>
      <Icon aria-hidden="true" /><span className="external-vault-browser__count" aria-hidden="true">{count.toLocaleString()}</span></Button>
    : <Button size="icon" variant="ghost" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick}><Icon aria-hidden="true" /></Button>;
}
