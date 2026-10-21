import { listen } from "@tauri-apps/api/event";
import { ASSET_LIFECYCLE_CHANGED_EVENT } from "./useAssetAuthoritySync";
import { nativeWorkload, workloadPollDelay, getWorkloadProfile } from "./workloadProfile";
import { isWindowFocused, subscribeWindowFocus, windowPollDelay } from "./windowFocus";
import { useEffect, useRef } from "react";
import type { ActivityItem } from "../layout/activityTimeline";
import type { CloudBackfillProgress, LibraryGateway } from "../library/types";
import { readCloudProgress } from "./cloudProgressRead";
import { afterLaunchSettled, launchSplashPresent } from "../shared/launch/LaunchSplash";

export const CLOUD_PROGRESS_EVENT = "lakomics:cloud-progress";

const CONTROL_EVENT = "lakomics:cloud-backfill-control-changed";
const ACTIVE_DELAY_MS = 1_500;
const INACTIVE_DELAY_MS = 10_000;
const IDLE_DELAY_MS = 60_000;

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
    let started = !launchSplashPresent();
    let checking = false;
    let wakePending = false;
    let timer: number | null = null;
    let nextDelay = INACTIVE_DELAY_MS;
    const schedule = (delay: number) => {
      if (disposed || !started) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void tick(); }, delay);
    };
    const tick = async () => {
      if (disposed || checking) return;
      if (getWorkloadProfile().hidden) { schedule(60_000); return; }
      checking = true;
      wakePending = false;
      nextDelay = INACTIVE_DELAY_MS;
      try {
        let progress = await readCloudProgress(gateway, libraryRoot);
        if (disposed || !progress) return;
        const workerActive = worker.current?.gateway === gateway && worker.current.root === libraryRoot;
        const enabled = !progress.syncHeld && progress.replicationEnabled !== false && progress.controlState !== "paused";
        if (enabled && remainingWork(progress) > 0) {
          nextDelay = ACTIVE_DELAY_MS;
          if (!workerActive && !nativeWorkload()) {
            // Keep the single status timer live while a long native cycle runs.
            const request = { gateway, root: libraryRoot, promise: gateway.cloudBackfillRunCycle() };
            worker.current = request;
            void request.promise.catch((error) => console.error("cloud replication failed", error))
              .finally(() => { if (worker.current === request) worker.current = null; });
          }
        } else if (!nativeWorkload() && enabled && !workerActive && progress.controlState === "running") {
          await gateway.cloudBackfillSetControlState?.("idle");
          // Status readers share this snapshot; publish a new value instead of mutating theirs.
          progress = { ...progress, controlState: "idle" };
        }
        if (enabled && (remainingWork(progress) > 0 || workerActive || progress.controlState === "running")) {
          nextDelay = ACTIVE_DELAY_MS;
        } else if (remainingWork(progress) === 0 && progress.controlState !== "running") {
          nextDelay = IDLE_DELAY_MS;
        }
        if (!disposed) window.dispatchEvent(new CustomEvent(CLOUD_PROGRESS_EVENT, { detail: { gateway, libraryRoot, progress } }));
      } catch (error) {
        console.error("cloud backfill supervisor failed", error);
      } finally {
        checking = false;
        schedule(wakePending ? 0 : windowPollDelay(workloadPollDelay(nextDelay)));
      }
    };
    // A signal arriving during the read must survive its completion.
    const wake = () => { if (checking) wakePending = true; else schedule(0); };
    window.addEventListener(CONTROL_EVENT, wake);
    window.addEventListener(ASSET_LIFECYCLE_CHANGED_EVENT, wake);
    const nativeStops: Array<() => void> = [];
    if (nativeWorkload()) {
      for (const event of ["extension://ingestion", "library://asset-authority-changed", "workload://changed"]) {
        void listen(event, wake).then(stop => { if (disposed) stop(); else nativeStops.push(stop); }).catch(() => undefined);
      }
      // Local imports already announce their start/completion through activities.
      // Ignore upload projections here: progress reads themselves publish those.
      let ingestionSignature = "[]";
      void listen<{ jobs: ActivityItem[] }>("library://activities-changed", ({ payload }) => {
        const signature = JSON.stringify(payload.jobs.filter(job => job.kind === "ingestion")
          .map(({ id, state, done, finishedAt }) => [id, state, done, finishedAt]));
        if (signature !== ingestionSignature) { ingestionSignature = signature; wake(); }
      }).then(stop => { if (disposed) stop(); else nativeStops.push(stop); }).catch(() => undefined);
    }
    const unsubscribeFocus = subscribeWindowFocus(() => {
      if (isWindowFocused()) wake();
      else schedule(windowPollDelay(workloadPollDelay(nextDelay)));
    });
    const start = () => { started = true; schedule(0); };
    const cancel = started ? (start(), () => undefined) : afterLaunchSettled(start);
    return () => {
      disposed = true;
      cancel();
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(CONTROL_EVENT, wake);
      window.removeEventListener(ASSET_LIFECYCLE_CHANGED_EVENT, wake);
      nativeStops.forEach(stop => stop());
      unsubscribeFocus();
    };
  }, [gateway, libraryRoot]);
}
