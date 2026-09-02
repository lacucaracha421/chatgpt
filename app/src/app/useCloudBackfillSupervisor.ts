import { useEffect } from "react";
import type { CloudBackfillProgress, LibraryGateway } from "../library/types";

const CONTROL_EVENT = "lakomics:cloud-backfill-control-changed";
const ACTIVE_DELAY_MS = 1_500;
const INACTIVE_DELAY_MS = 10_000;

export function notifyCloudBackfillSupervisor() {
  window.dispatchEvent(new Event(CONTROL_EVENT));
}

function remainingWork(progress: CloudBackfillProgress): number {
  return progress.queued + progress.preparing + progress.uploading + progress.committing;
}

export function useCloudBackfillSupervisor(gateway: LibraryGateway, libraryRoot: string) {
  useEffect(() => {
    let disposed = false;
    let cycleActive = false;
    let timer: number | null = null;

    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void tick(); }, delay);
    };

    const tick = async () => {
      if (disposed || cycleActive) return;
      cycleActive = true;
      let nextDelay = INACTIVE_DELAY_MS;
      try {
        let progress = await gateway.cloudBackfillProgress();
        if (!progress) return;
        // 정상(steady-state) 흐름: 컨트롤이 idle이어도 ingestion이 만든
        // 증분 pending 자산은 자동으로 복제되어야 한다. running 컨트롤은
        // 사용자가 시작한 전체 백필 주행이고, idle 구간의 pending은
        // 일상 저장 활동이 만든 증분 work다. 두 경우 모두 같은 워커
        // 사이클이 처리하며, idle 구간 처리는 컨트롤 상태를 바꾸지
        // 않는다(설정 UI의 진행 표시와 무관하게 동작).
        if (progress.controlState === "running" || remainingWork(progress) > 0) {
          if (remainingWork(progress) > 0) {
            await gateway.cloudBackfillRunCycle();
            progress = await gateway.cloudBackfillProgress();
            if (!progress) return;
          }
          if (progress.controlState === "running" && remainingWork(progress) === 0) {
            await gateway.cloudBackfillSetControlState?.("idle");
            window.dispatchEvent(new Event(CONTROL_EVENT));
          } else if (remainingWork(progress) > 0) {
            nextDelay = ACTIVE_DELAY_MS;
          }
        }
      } catch (error) {
        console.error("cloud backfill supervisor failed", error);
      } finally {
        cycleActive = false;
        schedule(nextDelay);
      }
    };

    const wake = () => schedule(0);
    window.addEventListener(CONTROL_EVENT, wake);
    schedule(0);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(CONTROL_EVENT, wake);
    };
  }, [gateway, libraryRoot]);
}
