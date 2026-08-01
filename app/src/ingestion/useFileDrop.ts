import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetSummary, LibraryGateway } from "../library/types";

export type DropSubscriber = (
  handler: (paths: string[]) => void,
) => Promise<() => void>;

export const subscribeToTauriDrops: DropSubscriber = async (handler) =>
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      handler(event.payload.paths);
    }
  });

export type FileDropResult =
  | { status: "added"; asset: AssetSummary; message: "저장했습니다" }
  | {
      status: "exact_duplicate";
      existingAssetId: string;
      message: "이미 보관된 파일입니다";
    }
  | { status: "error"; message: string };

export type DropProgress = { current: number; total: number };

type UseFileDropOptions = {
  subscribe: DropSubscriber;
  enabled: boolean;
  classificationId: string | null;
  ingestImage: LibraryGateway["ingestImage"];
  onResult: (result: FileDropResult) => void;
};

export function useFileDrop({
  subscribe,
  enabled,
  classificationId,
  ingestImage,
  onResult,
}: UseFileDropOptions): DropProgress | null {
  const [progress, setProgress] = useState<DropProgress | null>(null);
  const optionsRef = useRef({ enabled, classificationId, ingestImage, onResult });
  useLayoutEffect(() => {
    optionsRef.current = { enabled, classificationId, ingestImage, onResult };
  }, [classificationId, enabled, ingestImage, onResult]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let pendingBatches = 0;
    let queue = Promise.resolve();
    void subscribe((paths) => {
      if (!active) return;
      const {
        enabled: dropEnabled,
        classificationId: dropClassificationId,
        ingestImage: ingestDroppedImage,
        onResult: reportResult,
      } = optionsRef.current;
      if (!dropEnabled) return;
      pendingBatches += 1;
      queue = queue
        .then(async () => {
          for (const [index, sourcePath] of paths.entries()) {
            if (!active) return;
            setProgress({ current: index + 1, total: paths.length });
            try {
              const result = await ingestDroppedImage({
                sourcePath,
                classificationId: dropClassificationId,
                sourceUrl: null,
              });
              if (!active) return;
              reportResult(
                result.status === "added"
                  ? { ...result, message: "저장했습니다" }
                  : { ...result, message: "이미 보관된 파일입니다" },
              );
            } catch (error) {
              if (!active) return;
              reportResult({
                status: "error",
                message: commandErrorMessage(
                  error,
                  "파일을 저장하지 못했습니다.",
                ),
              });
            }
          }
        })
        .finally(() => {
          pendingBatches -= 1;
          if (active && pendingBatches === 0) setProgress(null);
        });
    })
      .then((stop) => {
        if (active) {
          unlisten = stop;
        } else {
          stop();
        }
      })
      .catch((error: unknown) => {
        if (active) {
          optionsRef.current.onResult({
            status: "error",
            message: commandErrorMessage(
              error,
              "파일 끌어놓기를 시작하지 못했습니다.",
            ),
          });
        }
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [subscribe]);

  return progress;
}
