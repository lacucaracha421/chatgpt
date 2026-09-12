import { useSyncExternalStore } from "react";
import { commandErrorMessage } from "./errorMessage";

export type PublishProgress = { phase: "connecting" | "preparing" | "uploading" | "publishing"; completed: number; total: number | null; unit: "items" | "files" | "bytes" };
export type PublicationKind = "catalog" | "collections";
export type PublicationJob = { kind: PublicationKind; running: boolean; progress: PublishProgress; message: string; error: boolean };
const listeners = new Set<() => void>();
let jobs: Partial<Record<PublicationKind, PublicationJob>> = {};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => jobs;
function update(kind: PublicationKind, job?: PublicationJob) {
  jobs = { ...jobs, [kind]: job };
  listeners.forEach(listener => listener());
}
export function usePublicationJobs() { return useSyncExternalStore(subscribe, snapshot); }
export function dismissPublication(kind: PublicationKind) { if (!jobs[kind]?.running) update(kind); }
/** Owned by the app session, independent of the initiating settings component. */
export async function startPublication<T>(kind: PublicationKind, run: (progress: (value: PublishProgress) => void) => Promise<T>, describe: (result: T) => string) {
  if (jobs[kind]?.running) return;
  const job: PublicationJob = { kind, running: true, progress: { phase: "connecting", completed: 0, total: null, unit: "items" }, message: "", error: false };
  update(kind, job);
  let active = true;
  try {
    const result = await run(progress => { if (active && jobs[kind]?.running) update(kind, { ...jobs[kind]!, progress }); });
    active = false;
    update(kind, { ...jobs[kind]!, running: false, message: describe(result) });
  } catch (error) {
    active = false;
    update(kind, { ...jobs[kind]!, running: false, error: true, message: commandErrorMessage(error, "게시하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.") });
  }
}
export const publicationLabel = (kind: PublicationKind) => kind === "catalog" ? "카탈로그 게시" : "모바일 컬렉션 업데이트";
export function publicationProgressText(progress: PublishProgress) {
  const phase = { connecting: "연결 확인", preparing: "자료 준비", uploading: "업로드", publishing: "서버 반영" }[progress.phase];
  if (progress.total == null) return phase;
  const format = (value: number) => progress.unit === "bytes" ? `${(value / 1024 / 1024).toFixed(1)} MB` : value.toLocaleString();
  return `${phase} · ${format(progress.completed)} / ${format(progress.total)}${progress.total > 0 ? ` (${Math.floor(progress.completed / progress.total * 100)}%)` : ""}`;
}
