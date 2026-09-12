import { useEffect, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { LibraryGateway } from "../library/types";

export type SimilarityIndexState = {
  running: boolean;
  remaining: number;
  failed: number;
  message?: string;
};

export function useSimilarityIndex(
  index: LibraryGateway["indexMissingSimilarityHashes"],
): SimilarityIndexState {
  const [state, setState] = useState<SimilarityIndexState>({
    running: true,
    remaining: 0,
    failed: 0,
  });

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const run = async () => {
      try {
        const progress = await index();
        if (!active) return;
        const running = progress.remaining > 0;
        setState({ running, remaining: progress.remaining, failed: progress.failed });
        if (running) timer = window.setTimeout(() => void run(), 0);
      } catch (error) {
        if (!active) return;
        setState({
          running: false,
          remaining: 0,
          failed: 0,
          message: commandErrorMessage(error, "유사 이미지 준비를 완료하지 못했습니다."),
        });
      }
    };

    void run();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [index]);

  return state;
}
