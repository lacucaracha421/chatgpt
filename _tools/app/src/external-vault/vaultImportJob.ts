import { useSyncExternalStore } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { EncryptedVaultImportProgress, EncryptedVaultImportReport, LibraryGateway } from "../library/types";

/**
 * The Private Vault import is owned by the app session, not by the 비밀 view: leaving the
 * view, focusing another window or reloading never stops or forgets it (the backend keeps
 * running and keeps the job; see `encrypted_vault_import_status`).
 */
export type VaultImportJob = {
  running: boolean;
  /** Null until the first progress arrives (the source folder is still being scanned). */
  progress: EncryptedVaultImportProgress | null;
  report: EncryptedVaultImportReport | null;
  /** Korean message when the import stopped. */
  error: string | null;
};
type Snapshot = { job: VaultImportJob | null; /** Increases whenever an import ends. */ completions: number };
type Gateway = Pick<LibraryGateway, "importIntoEncryptedVault" | "importFilesIntoEncryptedVault" | "getEncryptedVaultImportStatus">;
type Runner = (onProgress: (progress: EncryptedVaultImportProgress) => void) => Promise<EncryptedVaultImportReport>;

export const VAULT_IMPORT_POLL_MS = 1_000;
const listeners = new Set<() => void>();
let snapshot: Snapshot = { job: null, completions: 0 };
/** True while this webview's own import call is awaiting its result. */
let ownCall = false;
let pollTimer: number | null = null;

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => snapshot;
function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}
function setJob(job: VaultImportJob | null) { publish({ ...snapshot, job }); }
function finish(result: { report: EncryptedVaultImportReport } | { error: string }) {
  const progress = snapshot.job?.progress ?? null;
  publish({
    job: { running: false, progress, report: "report" in result ? result.report : null, error: "error" in result ? result.error : null },
    completions: snapshot.completions + 1,
  });
}

export function useVaultImportJob() { return useSyncExternalStore(subscribe, read); }

/** Clears a finished job after its summary was seen; a running job stays. */
export function dismissVaultImport() { if (snapshot.job && !snapshot.job.running) setJob(null); }

/** Starts an import of `folder`. While one runs (here or in the backend) it shows that job instead. */
export async function startVaultImport(gateway: Gateway, folder: string) {
  const importFolder = gateway.importIntoEncryptedVault;
  await runImport(gateway, importFolder && ((onProgress) => importFolder(folder, onProgress)));
}

/** 파일 추가: the same import job for individually chosen files. */
export async function startVaultFileImport(gateway: Gateway, files: string[]) {
  const importFiles = gateway.importFilesIntoEncryptedVault;
  if (files.length === 0) return;
  await runImport(gateway, importFiles && ((onProgress) => importFiles(files, onProgress)));
}

async function runImport(gateway: Gateway, run: Runner | undefined) {
  if (snapshot.job?.running || !run) return;
  ownCall = true;
  setJob({ running: true, progress: null, report: null, error: null });
  try {
    const report = await run((progress) => {
      if (snapshot.job?.running) setJob({ ...snapshot.job, progress });
    });
    ownCall = false;
    finish({ report });
  } catch (cause) {
    ownCall = false;
    if (errorCode(cause) === "encrypted_vault_import_running") {
      setJob(null);
      await reattachVaultImport(gateway);
      return;
    }
    finish({ error: importErrorMessage(errorCode(cause), cause) });
  }
}

/**
 * Follows an import this webview did not start or no longer awaits (after a reload, or a
 * second start while one runs): polls the backend job until it ends. Returns whether an
 * import is running.
 */
export async function reattachVaultImport(gateway: Gateway): Promise<boolean> {
  if (ownCall || pollTimer !== null) return Boolean(snapshot.job?.running);
  const getter = gateway.getEncryptedVaultImportStatus;
  if (!getter) return false;
  let job;
  try { job = await getter(); } catch { return false; }
  if (!job?.running || ownCall || pollTimer !== null) return Boolean(snapshot.job?.running);
  setJob({ running: true, progress: job.progress, report: null, error: null });
  const poll = async () => {
    let current;
    try { current = await getter(); } catch { current = undefined; }
    if (current?.running) {
      setJob({ running: true, progress: current.progress, report: null, error: null });
      pollTimer = window.setTimeout(() => void poll(), VAULT_IMPORT_POLL_MS);
      return;
    }
    pollTimer = null;
    if (current?.report) finish({ report: current.report });
    else finish({ error: importErrorMessage(current?.error ?? null, null) });
  };
  pollTimer = window.setTimeout(() => void poll(), VAULT_IMPORT_POLL_MS);
  return true;
}

export function vaultImportProgressText(job: VaultImportJob) {
  const progress = job.progress;
  return progress && progress.total > 0
    ? `가져오는 중 ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}`
    : "파일을 확인하는 중…";
}

export function vaultImportResultText(job: VaultImportJob) {
  if (job.error) return job.error;
  const report = job.report;
  if (!report) return "가져오기를 마쳤습니다.";
  return [
    `완료 · 가져옴 ${report.imported.toLocaleString()}개`,
    report.sidecarThumbnails ? `영상 썸네일로 적용 ${report.sidecarThumbnails.toLocaleString()}개` : null,
    report.failed > 0 ? `실패 ${report.failed.toLocaleString()}개` : null,
  ].filter(Boolean).join(" · ");
}

/** Test-only: module state outlives a test's render tree. */
export function resetVaultImportJob() {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
  ownCall = false;
  snapshot = { job: null, completions: 0 };
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

const RESUME_HINT = "다시 가져오면 이어서 진행합니다.";
function importErrorMessage(code: string | null, cause: unknown) {
  if (code === "encrypted_vault_locked") return `비밀 보관함이 잠겨 가져오기를 멈췄습니다. ${RESUME_HINT}`;
  if (code === "encrypted_vault_not_found") return `비밀 보관함 USB를 찾을 수 없어 가져오기를 멈췄습니다. ${RESUME_HINT}`;
  if (code === "encrypted_vault_folder_unavailable") return "가져올 폴더를 읽을 수 없습니다.";
  return commandErrorMessage(cause, `가져오지 못했습니다. ${RESUME_HINT}`);
}
