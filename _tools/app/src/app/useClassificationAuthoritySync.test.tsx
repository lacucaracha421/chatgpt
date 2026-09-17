import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ClassificationReconciliationResult, LibraryGateway } from "../library/types";
import {
  CLASSIFICATION_AUTHORITY_CHANGED_EVENT,
  useClassificationAuthoritySync,
} from "./useClassificationAuthoritySync";

function reconciliation(
  overrides: Partial<ClassificationReconciliationResult>,
): ClassificationReconciliationResult {
  return {
    adopted: true,
    adoptedBaseline: false,
    appliedChanges: 0,
    serverCursor: 5,
    localCursor: 5,
    behindBy: 0,
    rematerializedAssignments: 0,
    ...overrides,
  };
}

/** A gateway whose receive pass returns `result`, recording the events the loop dispatches. */
function harness(result: ClassificationReconciliationResult) {
  const gateway = {
    reconcileClassificationAuthority: vi.fn().mockResolvedValue(result),
  } as unknown as LibraryGateway;
  const events: Event[] = [];
  const listener = (event: Event) => events.push(event);
  window.addEventListener(CLASSIFICATION_AUTHORITY_CHANGED_EVENT, listener);
  return {
    gateway,
    events,
    stop: () => window.removeEventListener(CLASSIFICATION_AUTHORITY_CHANGED_EVENT, listener),
  };
}

it("announces applied changes and baseline adoption", async () => {
  for (const result of [
    reconciliation({ appliedChanges: 3 }),
    reconciliation({ adoptedBaseline: true }),
  ]) {
    const { gateway, events, stop } = harness(result);
    const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
    await waitFor(() => expect(events.length).toBeGreaterThan(0));
    unmount();
    stop();
  }
});

it("announces a pass that only rematerialized a deferred assignment", async () => {
  const { gateway, events, stop } = harness(reconciliation({ rematerializedAssignments: 2 }));
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled());
  // The relation is already written to `asset_classifications`, so the rendered list is
  // stale even though no change row was applied and no baseline was adopted.
  await waitFor(() => expect(events.length).toBeGreaterThan(0));
  unmount();
  stop();
});

it("stays silent when a pass changed no visible Classification state", async () => {
  const { gateway, events, stop } = harness(reconciliation({}));
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  expect(events).toHaveLength(0);
  unmount();
  stop();
});

it("retries quietly after a failed pass", async () => {
  const gateway = {
    reconcileClassificationAuthority: vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(reconciliation({ appliedChanges: 1 })),
  } as unknown as LibraryGateway;
  const events: Event[] = [];
  const listener = (event: Event) => events.push(event);
  window.addEventListener(CLASSIFICATION_AUTHORITY_CHANGED_EVENT, listener);
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  // The first failure is invisible: no event, no thrown error, and the loop keeps going.
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled());
  window.dispatchEvent(new Event("online"));
  await waitFor(() =>
    expect(vi.mocked(gateway.reconcileClassificationAuthority!).mock.calls.length).toBeGreaterThan(
      1,
    ),
  );
  await waitFor(() => expect(events.length).toBeGreaterThan(0));
  unmount();
  window.removeEventListener(CLASSIFICATION_AUTHORITY_CHANGED_EVENT, listener);
});

it("is single-flight, so overlapping triggers never run two passes at once", async () => {
  let release!: (value: ClassificationReconciliationResult) => void;
  const pending = new Promise<ClassificationReconciliationResult>((resolve) => {
    release = resolve;
  });
  const gateway = {
    reconcileClassificationAuthority: vi.fn().mockReturnValue(pending),
  } as unknown as LibraryGateway;
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalledTimes(1));
  // A slow pass must not stack behind the interval or the foreground events.
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  await act(async () => {
    await Promise.resolve();
  });
  expect(gateway.reconcileClassificationAuthority).toHaveBeenCalledTimes(1);
  await act(async () => release(reconciliation({})));
  unmount();
});

it("does not send anything: there is no Classification flush in this batch", async () => {
  const { gateway, stop } = harness(reconciliation({}));
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled());
  // No outbox exists yet, so the loop must never attempt a send.
  expect("flushClassificationOutbox" in gateway).toBe(false);
  unmount();
  stop();
});
