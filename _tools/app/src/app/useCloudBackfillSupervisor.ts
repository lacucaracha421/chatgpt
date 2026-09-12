import { useEffect, useRef } from "react";
import type { CloudBackfillProgress, LibraryGateway } from "../library/types";

export const CLOUD_PROGRESS_EVENT = "lakomics:cloud-progress";

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
  const worker = useRef<{ gateway: LibraryGateway; root: string; promise: Promise<unknown> } | null>(null);
  useEffect(() => {
    let disposed = false;
    let checking = false;
    let timer: number | null = null;
    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void tick(); }, delay);
    };
    const tick = async () => {
      if (disposed || checking) return;
      checking = true;
      let nextDelay = INACTIVE_DELAY_MS;
      try {
        const progress = await gateway.cloudBackfillProgress();
        if (disposed || !progress) return;
        const workerActive = worker.current?.gateway === gateway && worker.current.root === libraryRoot;
        const enabled = progress.replicationEnabled !== false && progress.controlState !== "paused";
        if (enabled && remainingWork(progress) > 0) {
          nextDelay = ACTIVE_DELAY_MS;
          if (!workerActive) {
            // Keep the single status timer live while a long native cycle runs.
            const request = { gateway, root: libraryRoot, promise: gateway.cloudBackfillRunCycle() };
            worker.current = request;
            void request.promise.catch((error) => console.error("cloud replication failed", error))
              .finally(() => { if (worker.current === request) worker.current = null; });
          }
        } else if (enabled && !workerActive && progress.controlState === "running") {
          await gateway.cloudBackfillSetControlState?.("idle");
          progress.controlState = "idle";
        }
        if (!disposed) window.dispatchEvent(new CustomEvent(CLOUD_PROGRESS_EVENT, { detail: { gateway, libraryRoot, progress } }));
      } catch (error) {
        console.error("cloud backfill supervisor failed", error);
      } finally {
        checking = false;
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
