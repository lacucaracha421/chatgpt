import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthoritySyncHealth, CloudBackfillProgress, LibraryGateway } from "../library/types";
import { ALBUM_AUTHORITY_CHANGED_EVENT } from "./useAlbumAuthoritySync";
import { ASSET_LIFECYCLE_CHANGED_EVENT } from "./useAssetAuthoritySync";
import { CLASSIFICATION_AUTHORITY_CHANGED_EVENT } from "./useClassificationAuthoritySync";
import { CLOUD_PROGRESS_EVENT } from "./useCloudBackfillSupervisor";
import { nativeWorkload } from "./workloadProfile";

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

const AUTHORITY_REFRESH_EVENTS = [ASSET_LIFECYCLE_CHANGED_EVENT, ALBUM_AUTHORITY_CHANGED_EVENT, CLASSIFICATION_AUTHORITY_CHANGED_EVENT];

/**
 * Local server-sync health (blocked, waiting, dropped intents and failing lanes). Read on
 * mount, on `refresh` (the status panel opening) and after authority changes; the command
 * reads only the local database, so this adds no server traffic and no polling.
 */
export function useAuthoritySyncHealth(gateway: LibraryGateway, libraryRoot: string) {
  const [health, setHealth] = useState<AuthoritySyncHealth | null>(null);
  const request = useRef(0);
  const refresh = useCallback(() => {
    if (!gateway.authoritySyncHealth) return;
    const id = ++request.current;
    void Promise.resolve().then(() => gateway.authoritySyncHealth!()).then(next => {
      if (id === request.current) setHealth(next);
    }).catch(() => undefined);
  }, [gateway]);
  useEffect(() => {
    setHealth(null);
    if (!gateway.authoritySyncHealth) return;
    refresh();
    let stopped = false;
    let unlisten: (() => void) | undefined;
    if (nativeWorkload()) {
      void listen("library://authority-health-changed", refresh)
        .then(stop => { if (stopped) stop(); else unlisten = stop; }).catch(() => undefined);
    }
    AUTHORITY_REFRESH_EVENTS.forEach(name => window.addEventListener(name, refresh));
    return () => {
      stopped = true;
      request.current += 1;
      unlisten?.();
      AUTHORITY_REFRESH_EVENTS.forEach(name => window.removeEventListener(name, refresh));
    };
  }, [gateway, libraryRoot, refresh]);
  return { health, refresh };
}
