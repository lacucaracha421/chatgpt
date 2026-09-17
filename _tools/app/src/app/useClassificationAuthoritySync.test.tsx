import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ClassificationReconciliationResult, LibraryGateway } from "../library/types";
import {
  CLASSIFICATION_AUTHORITY_CHANGED_EVENT,
  useClassificationAuthoritySync,
} from "./useClassificationAuthoritySync";

const flush = { sent: 0, noOp: 0, rebased: 0, blocked: 0, pending: 0, stopped: false };

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
    deferredToOutbox: false,
    ...overrides,
  };
}

/**
 * A gateway whose flush reports `flushed` and whose receive returns `result`, recording
 * the events the loop dispatches.
 */
function harness(
  result: ClassificationReconciliationResult,
  flushed: typeof flush = flush,
) {
  const gateway = {
    flushClassificationOutbox: vi.fn().mockResolvedValue(flushed),
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

it("flushes before receiving", async () => {
  const gateway = {
    flushClassificationOutbox: vi.fn().mockResolvedValue(flush),
    reconcileClassificationAuthority: vi.fn().mockResolvedValue(reconciliation({})),
  } as unknown as LibraryGateway;
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled());
  // The queue must be drained before a received page may touch the same state.
  const flushed = vi.mocked(gateway.flushClassificationOutbox!).mock.invocationCallOrder[0];
  const received = vi.mocked(gateway.reconcileClassificationAuthority!).mock
    .invocationCallOrder[0];
  expect(flushed).toBeLessThan(received);
  unmount();
});

it("does not receive while the flush stopped on an unresolved intent", async () => {
  const { gateway, events, stop } = harness(
    reconciliation({ appliedChanges: 2 }),
    { ...flush, blocked: 1, pending: 1, stopped: true },
  );
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.flushClassificationOutbox).toHaveBeenCalled());
  // A blocked queue means a structural conflict is waiting for the user, and receive has
  // nothing safe to do over it.
  expect(gateway.reconcileClassificationAuthority).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
  unmount();
  stop();
});

it("receives once the flush leaves the queue clean", async () => {
  const { gateway, events, stop } = harness(reconciliation({ appliedChanges: 3 }));
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(events.length).toBeGreaterThan(0));
  expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled();
  unmount();
  stop();
});

it("announces a pass that only rematerialized a deferred assignment", async () => {
  const { gateway, events, stop } = harness(reconciliation({ rematerializedAssignments: 2 }));
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(events.length).toBeGreaterThan(0));
  unmount();
  stop();
});

it("announces applied changes and baseline adoption as before", async () => {
  for (const result of [
    reconciliation({ appliedChanges: 4 }),
    reconciliation({ adoptedBaseline: true }),
  ]) {
    const { gateway, events, stop } = harness(result);
    const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
    await waitFor(() => expect(events.length).toBeGreaterThan(0));
    unmount();
    stop();
  }
});

it("stays silent when a pass changed no visible Classification state", async () => {
  const { gateway, events, stop } = harness(reconciliation({}));
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled());
  // A poll that converged nothing must not churn the UI.
  await act(async () => {
    await Promise.resolve();
  });
  expect(events).toHaveLength(0);
  unmount();
  stop();
});

it("stays silent when the receive was deferred to the outbox", async () => {
  const { gateway, events, stop } = harness(
    reconciliation({ deferredToOutbox: true, appliedChanges: 0 }),
  );
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  // Nothing was applied, so nothing is announced.
  expect(events).toHaveLength(0);
  unmount();
  stop();
});

it("retries quietly after a failed flush", async () => {
  const gateway = {
    flushClassificationOutbox: vi.fn().mockRejectedValue(new Error("offline")),
    reconcileClassificationAuthority: vi.fn().mockResolvedValue(reconciliation({})),
  } as unknown as LibraryGateway;
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.flushClassificationOutbox).toHaveBeenCalled());
  // A failed send must not attempt a receive over an unresolved queue.
  expect(gateway.reconcileClassificationAuthority).not.toHaveBeenCalled();
  unmount();
});

it("retries quietly after a failed receive", async () => {
  const gateway = {
    flushClassificationOutbox: vi.fn().mockResolvedValue(flush),
    reconcileClassificationAuthority: vi.fn().mockRejectedValue(new Error("offline")),
  } as unknown as LibraryGateway;
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileClassificationAuthority).toHaveBeenCalled());
  unmount();
});

it("is single-flight, so overlapping triggers never run two passes at once", async () => {
  let release: (() => void) | undefined;
  const gateway = {
    flushClassificationOutbox: vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { release = () => resolve(); }).then(() => flush),
    ),
    reconcileClassificationAuthority: vi.fn().mockResolvedValue(reconciliation({})),
  } as unknown as LibraryGateway;
  const { unmount } = renderHook(() => useClassificationAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.flushClassificationOutbox).toHaveBeenCalledTimes(1));
  act(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
  });
  expect(gateway.flushClassificationOutbox).toHaveBeenCalledTimes(1);
  await act(async () => {
    release?.();
    await Promise.resolve();
  });
  unmount();
});
