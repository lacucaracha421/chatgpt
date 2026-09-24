import { useEffect, useState } from "react";
import type { CloudBackfillProgress, LibraryGateway } from "../library/types";
import { CLOUD_PROGRESS_EVENT } from "./useCloudBackfillSupervisor";

// Queue failures are individual assets; transport/metadata failures are one
// actionable problem per direction. A failed replication cycle is not counted twice.
export function cloudProblemCount(progress: CloudBackfillProgress): number {
  return progress.failed + (progress.activity ?? []).reduce((sum, item) => sum
    + (item.lastError && (item.direction === "capture" || progress.failed === 0) ? 1 : 0)
    + (item.metadataLastError ? 1 : 0), 0);
}

export type CloudSyncStatus = { problemCount: number; progress: CloudBackfillProgress | null };

/** The latest cloud replication snapshot, shared by the status panel and its problem count. */
export function useCloudSyncStatus(gateway: LibraryGateway, libraryRoot: string): CloudSyncStatus {
  const [progress, setProgress] = useState<CloudBackfillProgress | null>(null);
  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    setProgress(null);
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.gateway === gateway && detail.libraryRoot === libraryRoot) {
        receivedUpdate = true;
        setProgress(detail.progress);
      }
    };
    window.addEventListener(CLOUD_PROGRESS_EVENT, receive);
    void Promise.resolve().then(() => gateway.cloudBackfillProgress()).then(progress => {
      if (active && !receivedUpdate && progress) setProgress(progress);
    }).catch(() => undefined);
    return () => { active = false; window.removeEventListener(CLOUD_PROGRESS_EVENT, receive); };
  }, [gateway, libraryRoot]);
  return { problemCount: progress ? cloudProblemCount(progress) : 0, progress };
}

export function useCloudProblems(gateway: LibraryGateway, libraryRoot: string) {
  return useCloudSyncStatus(gateway, libraryRoot).problemCount;
}
