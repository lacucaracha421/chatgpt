import { useEffect } from "react";
import type { CollectionUpdateProvider, LibraryGateway, ReleaseWatchRunResult } from "../library/types";

const CHECK_INTERVAL_MS = 3_600_000;
const CONTINUATION_MS = 1_000;

export function useReleaseWatchCheck(
  gateway: LibraryGateway,
  libraryRoot: string,
  onChanged: (result: ReleaseWatchRunResult) => Promise<void>,
) {
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      let nextWakeAt = Date.now() + CHECK_INTERVAL_MS;
      const scheduleRetry = (retryAt: string | null) => {
        const remaining = retryAt ? Date.parse(retryAt) - Date.now() : NaN;
        if (Number.isFinite(remaining)) nextWakeAt = Math.min(nextWakeAt, Date.now() + Math.max(CONTINUATION_MS, remaining));
      };
      try {
        const api = gateway.collectionTracking;
        if (api?.runUpdates && api.updateStatus) {
          for (const provider of ["mangadex", "kakao"] as CollectionUpdateProvider[]) {
            if (!active) break;
            try {
              const before = await api.updateStatus(provider);
              if (!active) break;
              if (!before.remaining) continue;
              if (before.retryAt && Date.parse(before.retryAt) > Date.now()) {
                scheduleRetry(before.retryAt);
                continue;
              }
              const result = await api.runUpdates(provider);
              if (!active) break;
              if (result.busy || (result.remaining > 0 && !result.retryAt)) nextWakeAt = Math.min(nextWakeAt, Date.now() + CONTINUATION_MS);
              else if (result.remaining > 0) scheduleRetry(result.retryAt);
              if (result.busy) continue;
              const previousChanges = result.startedAt === before.startedAt ? before.changedCollections : 0;
              const previousChecked = result.startedAt === before.startedAt ? before.checked : 0;
              if (result.checked > previousChecked) await onChanged({
                provider, checked: result.checked - previousChecked,
                changedCollections: Math.max(0, result.changedCollections - previousChanges),
                skipped: result.failed, stopReason: result.stopReason,
              });
            } catch {
              // Provider failures are independent. Persistent provider status is
              // shown in its inbox; an IPC failure retries on the hourly pass.
            }
          }
        } else {
          const result = await gateway.runDueReleaseWatch();
          if (active) await onChanged(result);
        }
      } finally {
        if (active) timer = setTimeout(() => void run().catch(() => undefined), Math.max(CONTINUATION_MS, nextWakeAt - Date.now()));
      }
    };
    void run().catch(() => undefined);
    return () => { active = false; clearTimeout(timer); };
    // Resubscribe only on gateway/library switch; callbacks read current app state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, libraryRoot]);
}
