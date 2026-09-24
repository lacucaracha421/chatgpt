import { useSyncExternalStore } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { EncryptedVaultExportProgress, LibraryGateway } from "../library/types";

/**
 * The Private Vault export (decrypted copies into a PC folder) is owned by the app session
 * like the import: leaving the 비밀 view never stops or forgets it.
 */
export type VaultExportJob = {
  running: boolean;
  progress: EncryptedVaultExportProgress | null;
  /** Korean message when the export stopped. */
  error: string | null;
};
type Gateway = Pick<LibraryGateway, "exportEncryptedVaultItems" | "getEncryptedVaultExportStatus">;
type Snapshot = { job: VaultExportJob | null };

export const VAULT_EXPORT_POLL_MS = 1_000;
const listeners = new Set<() => void>();
let snapshot: Snapshot = { job: null };
let ownCall = false;
let pollTimer: number | null = null;

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => snapshot;
function setJob(job: VaultExportJob | null) {
  snapshot = { job };
  listeners.forEach((listener) => listener());
}

export function useVaultExportJob() { return useSyncExternalStore(subscribe, read).job; }

/** Clears a finished export after its summary was seen; a running one stays. */
export function dismissVaultExport() { if (snapshot.job && !snapshot.job.running) setJob(null); }

/** Exports `itemIds` into `destination`. While one runs (here or in the backend) it follows that job instead. */
export async function startVaultExport(gateway: Gateway, itemIds: string[], destination: string) {
  if (snapshot.job?.running || !gateway.exportEncryptedVaultItems || itemIds.length === 0) return;
  ownCall = true;
  setJob({ running: true, progress: null, error: null });
  try {
    const report = await gateway.exportEncryptedVaultItems(itemIds, destination, (progress) => {
      if (snapshot.job?.running) setJob({ ...snapshot.job, progress });
    });
    ownCall = false;
    setJob({ running: false, progress: report, error: null });
  } catch (cause) {
    ownCall = false;
    if (errorCode(cause) === "encrypted_vault_import_running") {
      setJob(null);
      await reattachVaultExport(gateway);
      return;
    }
    setJob({ running: false, progress: snapshot.job?.progress ?? null, error: exportErrorMessage(errorCode(cause), cause) });
  }
}

/** Follows an export this webview did not start or no longer awaits. Returns whether one is running. */
export async function reattachVaultExport(gateway: Gateway): Promise<boolean> {
  if (ownCall || pollTimer !== null) return Boolean(snapshot.job?.running);
  const getter = gateway.getEncryptedVaultExportStatus;
  if (!getter) return false;
  let job;
  try { job = await getter(); } catch { return false; }
  if (!job?.running || ownCall || pollTimer !== null) return Boolean(snapshot.job?.running);
  setJob({ running: true, progress: job.progress, error: null });
  const poll = async () => {
    let current;
    try { current = await getter(); } catch { current = undefined; }
    if (current?.running) {
      setJob({ running: true, progress: current.progress, error: null });
      pollTimer = window.setTimeout(() => void poll(), VAULT_EXPORT_POLL_MS);
      return;
    }
    pollTimer = null;
    setJob({
      running: false,
      progress: current?.progress ?? snapshot.job?.progress ?? null,
      error: current && !current.error ? null : exportErrorMessage(current?.error ?? null, null),
    });
  };
  pollTimer = window.setTimeout(() => void poll(), VAULT_EXPORT_POLL_MS);
  return true;
}

export function vaultExportProgressText(job: VaultExportJob) {
  const progress = job.progress;
  return progress && progress.total > 0
    ? `내보내는 중 ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}`
    : "내보낼 준비 중…";
}

export function vaultExportResultText(job: VaultExportJob) {
  if (job.error) return job.error;
  const progress = job.progress;
  if (!progress) return "내보내기를 마쳤습니다.";
  return [
    `완료 · 내보냄 ${progress.exported.toLocaleString()}개`,
    progress.failed > 0 ? `실패 ${progress.failed.toLocaleString()}개` : null,
  ].filter(Boolean).join(" · ");
}

/** Test-only: module state outlives a test's render tree. */
export function resetVaultExportJob() {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
  ownCall = false;
  snapshot = { job: null };
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function exportErrorMessage(code: string | null, cause: unknown) {
  if (code === "encrypted_vault_invalid_root") return "비밀 보관함 USB 안으로는 내보낼 수 없습니다. PC의 폴더를 고르세요.";
  if (code === "encrypted_vault_folder_unavailable") return "내보낼 폴더에 쓸 수 없습니다.";
  if (code === "encrypted_vault_locked") return "비밀 보관함이 잠겨 내보내기를 멈췄습니다. 이미 내보낸 파일은 폴더에 남아 있습니다.";
  if (code === "encrypted_vault_not_found") return "비밀 보관함 USB를 찾을 수 없어 내보내기를 멈췄습니다.";
  return commandErrorMessage(cause, "내보내지 못했습니다.");
}
