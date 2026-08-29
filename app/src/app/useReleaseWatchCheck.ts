import { useEffect } from "react";
import type { LibraryGateway, ReleaseWatchRunResult } from "../library/types";

// run_due_release_watch는 due 판정을 서버(마지막 확인 시각) 기준으로 하므로
// 자주 불러도 무의미한 호출은 무시된다. 1시간마다 due 만료를 확인한다.
const RELEASE_WATCH_CHECK_INTERVAL_MS = 3_600_000;

export function useReleaseWatchCheck(
  gateway: LibraryGateway,
  libraryRoot: string,
  onChanged: (result: ReleaseWatchRunResult) => Promise<void>,
) {
  useEffect(() => {
    let active = true;
    let running = false;
    const run = async () => {
      if (!active || running) return;
      running = true;
      try {
        const result = await gateway.runDueReleaseWatch();
        if (!active) return;
        // 기존 시작 확인도 결과와 관계없이 컬렉션을 갱신했다. 신간이 있으면 알림을 얹는다.
        await onChanged(result);
      } catch {
        // 개별 컬렉션 화면과 토스트로 오류를 노출한다. 주기 확인은 조용히 재시도한다.
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), RELEASE_WATCH_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    // 라이브러리 전환 시에만 재구독한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, libraryRoot]);
}