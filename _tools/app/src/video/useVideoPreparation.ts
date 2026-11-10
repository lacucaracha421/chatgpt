import { createContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { LibraryGateway, VideoPreparationProgress } from "../library/types";
import type { IngestionWork } from "../ingestion/useFileDrop";

// Scoped to the App tree: viewers report playback without threading callbacks
// through every browser that can open an AssetViewer.
export const VideoPlaybackContext = createContext<((playing: boolean) => void) | null>(null);

const WORK_ID = "video-preparation";

type Options = {
  enabled: boolean;
  playing?: boolean;
  trigger: number;
  prepare: LibraryGateway["preparePendingVideos"];
  retry: LibraryGateway["retryVideoPreparation"];
  onChanged(assetIds: string[]): void;
};

export function useVideoPreparation(options: Options) {
  const [work, setWork] = useState<IngestionWork | null>(null);
  const optionsRef = useRef(options);
  const activeRef = useRef(true);
  const runningRef = useRef(false);
  const requestedRef = useRef(false);
  const completedRef = useRef(0);
  const failedAssetIdRef = useRef<string | null>(null);
  const runRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestedRef.current = false;
    };
  }, []);

  const applyProgress = useCallback((progress: VideoPreparationProgress) => {
    if (!activeRef.current) return false;
    if (progress.changedAssetIds.length > 0) {
      optionsRef.current.onChanged(progress.changedAssetIds);
    }
    // Nothing left, or no progress while stopped/restricted: do not leave a
    // "running" status behind for work that is not running.
    if (progress.processed === 0 && progress.failed === 0) {
      if (completedRef.current === 0 || progress.remaining > 0) setWork(null);
      return false;
    }
    completedRef.current += progress.processed;
    failedAssetIdRef.current = progress.failed > 0
      ? (progress.changedAssetIds[0] ?? null)
      : null;
    setWork({
      kind: "preparation",
      id: WORK_ID,
      total: completedRef.current + progress.remaining,
      completed: completedRef.current,
      added: 0,
      exactDuplicates: [],
      reviewPending: [],
      failures: progress.failed > 0
        ? [{ fileName: failedAssetIdRef.current ?? "video", message: "미리보기 준비 실패" }]
        : [],
      status: progress.failed > 0
        ? "failed"
        : progress.remaining > 0
          ? "running"
          : "completed",
    });
    // No progress can mean preparation is temporarily restricted. Wait for the
    // next natural trigger instead of immediately polling the same work again.
    return progress.processed > 0 && progress.remaining > 0;
  }, []);

  runRef.current = () => {
    requestedRef.current = true;
    if (runningRef.current || !activeRef.current || !optionsRef.current.enabled || optionsRef.current.playing) return;
    runningRef.current = true;
    queueMicrotask(async () => {
      try {
        requestedRef.current = false;
        while (activeRef.current && optionsRef.current.enabled && !optionsRef.current.playing) {
          let progress: VideoPreparationProgress;
          try {
            progress = await optionsRef.current.prepare(1);
          } catch (error) {
            if (activeRef.current) {
              setWork({
                kind: "preparation",
                id: WORK_ID,
                total: 1,
                completed: 0,
                added: 0,
                exactDuplicates: [],
                reviewPending: [],
                failures: [{
                  fileName: "video",
                  message: commandErrorMessage(error, "미리보기 준비 실패"),
                }],
                status: "failed",
              });
            }
            break;
          }
          if (!applyProgress(progress)) break;
          await Promise.resolve();
        }
      } finally {
        runningRef.current = false;
        if (requestedRef.current && activeRef.current) runRef.current();
      }
    });
  };

  useEffect(() => {
    if (!options.enabled || options.playing) return;
    if (!runningRef.current) {
      completedRef.current = 0;
      failedAssetIdRef.current = null;
    }
    runRef.current();
  }, [options.enabled, options.playing, options.trigger]);

  const retryFailed = useCallback(async () => {
    const assetId = failedAssetIdRef.current;
    if (assetId) await optionsRef.current.retry(assetId);
    completedRef.current = 0;
    failedAssetIdRef.current = null;
    setWork(null);
    runRef.current();
  }, []);

  const dismissWork = useCallback(() => setWork(null), []);

  return { work, retryFailed, dismissWork };
}
