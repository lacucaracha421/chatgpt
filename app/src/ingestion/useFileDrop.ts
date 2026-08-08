import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetSummary, LibraryGateway } from "../library/types";

export type NativeFileDropEvent =
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "cancel" };

type CompatibleDropEvent = NativeFileDropEvent | string[];
export type DropSubscriber = (handler: (event: CompatibleDropEvent) => void) => Promise<() => void>;

export const subscribeToTauriDrops: DropSubscriber = async (handler) =>
  getCurrentWebview().onDragDropEvent((event) => handler(event.payload as NativeFileDropEvent));

export type FileDropResult =
  | { status: "added"; asset: AssetSummary; message: "저장했습니다" }
  | { status: "exact_duplicate"; existingAssetId: string; message: "이미 보관된 파일입니다" }
  | { status: "error"; message: string };

export type DropProgress = { current: number; total: number };
export type IngestionWork = {
  id: string;
  total: number;
  completed: number;
  failures: Array<{ sourcePath: string; message: string }>;
  status: "running" | "completed" | "failed";
};

type UseFileDropOptions = {
  subscribe: DropSubscriber;
  enabled: boolean;
  classificationId: string | null;
  ingestImage: LibraryGateway["ingestImage"];
  onResult: (result: FileDropResult) => void;
};

export type FileDropState = {
  progress: DropProgress | null;
  over: { x: number; y: number } | null;
  works: IngestionWork[];
  retryFailed: (workId: string) => void;
};

export function useFileDrop({ subscribe, enabled, classificationId, ingestImage, onResult }: UseFileDropOptions): FileDropState {
  const [progress, setProgress] = useState<DropProgress | null>(null);
  const [over, setOver] = useState<{ x: number; y: number } | null>(null);
  const [works, setWorks] = useState<IngestionWork[]>([]);
  const optionsRef = useRef({ enabled, classificationId, ingestImage, onResult });
  const enqueueRef = useRef<(paths: string[], destination: string | null, workId?: string) => void>(() => undefined);
  const workContexts = useRef(new Map<string, { classificationId: string | null; failedPaths: string[] }>());

  useLayoutEffect(() => {
    optionsRef.current = { enabled, classificationId, ingestImage, onResult };
  }, [classificationId, enabled, ingestImage, onResult]);

  const retryFailed = useCallback((workId: string) => {
    const context = workContexts.current.get(workId);
    if (!context || context.failedPaths.length === 0) return;
    enqueueRef.current(context.failedPaths, context.classificationId, workId);
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
        ? current.map((work) => work.id === workId ? { ...work, total: paths.length, completed: 0, failures: [], status: "running" } : work)
        : [...current, { id: workId, total: paths.length, completed: 0, failures: [], status: "running" }]);
      pendingBatches += 1;
      queue = queue.then(async () => {
        const failures: IngestionWork["failures"] = [];
        for (const [index, sourcePath] of paths.entries()) {
          if (!active) return;
          setProgress({ current: index + 1, total: paths.length });
          try {
            const result = await optionsRef.current.ingestImage({ sourcePath, classificationId: destination, sourceUrl: null });
            if (!active) return;
            optionsRef.current.onResult(result.status === "added"
              ? { ...result, message: "저장했습니다" }
              : { ...result, message: "이미 보관된 파일입니다" });
          } catch (error) {
            if (!active) return;
            const message = commandErrorMessage(error, "파일을 저장하지 못했습니다.");
            failures.push({ sourcePath, message });
            optionsRef.current.onResult({ status: "error", message });
          }
          setWorks((current) => current.map((work) => work.id === workId
            ? { ...work, completed: index + 1, failures: [...failures] }
            : work));
        }
        if (!active) return;
        workContexts.current.set(workId, { classificationId: destination, failedPaths: failures.map((failure) => failure.sourcePath) });
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
      if (active) optionsRef.current.onResult({ status: "error", message: commandErrorMessage(error, "파일 놓기를 시작하지 못했습니다.") });
    });
    return () => {
      active = false;
      enqueueRef.current = () => undefined;
      unlisten?.();
    };
  }, [subscribe]);

  return { progress, over, works, retryFailed };
}
