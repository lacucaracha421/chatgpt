import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetSummary, IngestOutcome, LibraryGateway } from "../library/types";

export type NativeFileDropEvent =
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "cancel" };

type CompatibleDropEvent = NativeFileDropEvent | string[];
export type DropSubscriber = (handler: (event: CompatibleDropEvent) => void) => Promise<() => void>;

export const subscribeToTauriDrops: DropSubscriber = async (handler) =>
  getCurrentWebview().onDragDropEvent((event) => handler(event.payload as NativeFileDropEvent));

export type FileDropResult =
  | { status: "added"; asset: AssetSummary; message: string }
  | { status: "exact_duplicate"; existingAssetId: string; message: string }
  | { status: "review_pending"; reviewId: string; message: string }
  | { status: "error"; message: string };

export type DropProgress = { current: number; total: number };
export type IngestionWork = {
  kind: "ingestion" | "drag_out" | "preparation";
  id: string;
  total: number;
  completed: number;
  added: number;
  exactDuplicates: Array<{ fileName: string; existingAssetId: string }>;
  reviewPending: Array<{ fileName: string; reviewId: string }>;
  failures: Array<{ fileName: string; message: string }>;
  status: "running" | "completed" | "failed";
};

type UseFileDropOptions = {
  subscribe: DropSubscriber;
  enabled: boolean;
  classificationId: string | null;
  ingestMedia: LibraryGateway["ingestMedia"];
  onIngested?: (result: IngestOutcome) => void;
  onFatalError?: (message: string) => void;
  // Kept temporarily so existing callers can migrate without changing drop semantics.
  onResult?: (result: FileDropResult) => void;
};

export type FileDropState = {
  progress: DropProgress | null;
  over: { x: number; y: number } | null;
  works: IngestionWork[];
  retryFailed: (workId: string) => void;
  dismissWork: (workId: string) => void;
};

export function useFileDrop(options: UseFileDropOptions): FileDropState {
  const { subscribe } = options;
  const [progress, setProgress] = useState<DropProgress | null>(null);
  const [over, setOver] = useState<{ x: number; y: number } | null>(null);
  const [works, setWorks] = useState<IngestionWork[]>([]);
  const optionsRef = useRef(options);
  const enqueueRef = useRef<(paths: string[], destination: string | null, workId?: string) => void>(() => undefined);
  const workContexts = useRef(new Map<string, { classificationId: string | null; failedPaths: string[] }>());

  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const retryFailed = useCallback((workId: string) => {
    const context = workContexts.current.get(workId);
    if (!context?.failedPaths.length) return;
    enqueueRef.current(context.failedPaths, context.classificationId, workId);
  }, []);

  const dismissWork = useCallback((workId: string) => {
    workContexts.current.delete(workId);
    setWorks((current) => current.filter((work) => work.id !== workId));
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let pendingBatches = 0;
    let queue = Promise.resolve();

    const enqueue = (paths: string[], destination: string | null, existingWorkId?: string) => {
      if (!active || paths.length === 0) return;
      const workId = existingWorkId ?? crypto.randomUUID();
      workContexts.current.set(workId, { classificationId: destination, failedPaths: [] });
      setWorks((current) => existingWorkId
        ? current.map((work) => work.id === workId ? emptyWork(workId, paths.length) : work)
        : [...current, emptyWork(workId, paths.length)]);
      pendingBatches += 1;
      queue = queue.then(async () => {
        let added = 0;
        const exactDuplicates: IngestionWork["exactDuplicates"] = [];
        const reviewPending: IngestionWork["reviewPending"] = [];
        const failures: IngestionWork["failures"] = [];
        const failedPaths: string[] = [];
        for (const [index, sourcePath] of paths.entries()) {
          if (!active) return;
          setProgress({ current: index + 1, total: paths.length });
          try {
            const result = await optionsRef.current.ingestMedia({
              sourcePath,
              classificationId: destination,
              sourceUrl: null,
            });
            if (!active) return;
            if (result.status === "added") added += 1;
            if (result.status === "exact_duplicate") {
              exactDuplicates.push({ fileName: fileName(sourcePath), existingAssetId: result.existingAssetId });
            }
            if (result.status === "review_pending") {
              reviewPending.push({ fileName: fileName(sourcePath), reviewId: result.reviewId });
            }
            optionsRef.current.onIngested?.(result);
            optionsRef.current.onResult?.(legacyResult(result));
          } catch (error) {
            if (!active) return;
            const message = commandErrorMessage(error, "파일을 저장하지 못했습니다.");
            failures.push({ fileName: fileName(sourcePath), message });
            failedPaths.push(sourcePath);
            optionsRef.current.onResult?.({ status: "error", message });
          }
          setWorks((current) => current.map((work) => work.id === workId
            ? {
                ...work,
                completed: index + 1,
                added,
                exactDuplicates: [...exactDuplicates],
                reviewPending: [...reviewPending],
                failures: [...failures],
              }
            : work));
        }
        if (!active) return;
        workContexts.current.set(workId, { classificationId: destination, failedPaths });
        setWorks((current) => current.map((work) => work.id === workId
          ? { ...work, completed: paths.length, failures, status: failures.length > 0 ? "failed" : "completed" }
          : work));
      }).finally(() => {
        pendingBatches -= 1;
        if (active && pendingBatches === 0) setProgress(null);
      });
    };
    enqueueRef.current = enqueue;

    void subscribe((incoming) => {
      if (!active) return;
      const event: NativeFileDropEvent = Array.isArray(incoming)
        ? { type: "drop", paths: incoming, position: { x: 0, y: 0 } }
        : incoming;
      if (event.type === "cancel") {
        setOver(null);
        return;
      }
      if (!optionsRef.current.enabled) {
        setOver(null);
        return;
      }
      if (event.type === "over") {
        setOver(event.position);
        return;
      }
      setOver(null);
      enqueue(event.paths, optionsRef.current.classificationId);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch((error: unknown) => {
      if (!active) return;
      const message = commandErrorMessage(error, "파일 놓기를 시작하지 못했습니다.");
      optionsRef.current.onFatalError?.(message);
      optionsRef.current.onResult?.({ status: "error", message });
    });
    return () => {
      active = false;
      enqueueRef.current = () => undefined;
      unlisten?.();
    };
  }, [subscribe]);

  return { progress, over, works, retryFailed, dismissWork };
}

function emptyWork(id: string, total: number): IngestionWork {
  return {
    kind: "ingestion",
    id,
    total,
    completed: 0,
    added: 0,
    exactDuplicates: [],
    reviewPending: [],
    failures: [],
    status: "running",
  };
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function legacyResult(result: IngestOutcome): FileDropResult {
  if (result.status === "added") return { ...result, message: "저장했습니다" };
  if (result.status === "exact_duplicate") return { ...result, message: "이미 보관된 파일입니다" };
  return { ...result, message: "유사 이미지 검토 대기" };
}
