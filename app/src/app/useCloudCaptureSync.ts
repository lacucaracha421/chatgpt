import { useEffect } from "react";
import type { LibraryGateway } from "../library/types";

// 클라우드 캡처 수신함(원격 → 로컬) 폴링. 시작 직후 1회 실행 뒤 5분 간격으로
// due 체크를 하고, 겹치는 실행은 허용하지 않는다. 실패는 조용히 무시한다 —
// 캡처 수집 실패가 로컬 동작을 막지 않는다.
const CAPTURE_DUE_CHECK_INTERVAL_MS = 5 * 60_000;

export function useCloudCaptureSync(gateway: LibraryGateway, libraryRoot: string, onResult: (result: Awaited<ReturnType<LibraryGateway["runDueCloudCaptureSync"]>>) => void) {
  useEffect(() => {
    let active = true;
    let running = false;
    const run = async () => {
      if (!active || running) return;
      running = true;
      try {
        const result = await gateway.runDueCloudCaptureSync();
        if (active) onResult(result);
      } catch {
        // 네트워크·설정 오류는 다음 폴링에서 다시 시도한다. 로컬 동작에는 영향이 없다.
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), CAPTURE_DUE_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [gateway, libraryRoot, onResult]);
}