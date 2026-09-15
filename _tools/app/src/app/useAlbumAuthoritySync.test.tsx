import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AlbumReconciliationResult, LibraryGateway } from "../library/types";
import { ALBUM_AUTHORITY_CHANGED_EVENT, useAlbumAuthoritySync } from "./useAlbumAuthoritySync";

const flush = { sent: 0, noOp: 0, blocked: 0, pending: 0, stopped: false };

function reconciliation(overrides: Partial<AlbumReconciliationResult>): AlbumReconciliationResult {
  return {
    adopted: true,
    adoptedBaseline: false,
    appliedChanges: 0,
    serverCursor: 5,
    localCursor: 5,
    behindBy: 0,
    rematerializedMemberships: 0,
    deferredToOutbox: false,
    ...overrides,
  };
}

/**
 * Build a gateway whose receive pass returns `result` and record the events the loop
 * dispatches.
 */
function harness(result: AlbumReconciliationResult) {
  const gateway = {
    flushAlbumOutbox: vi.fn().mockResolvedValue(flush),
    reconcileAlbumAuthority: vi.fn().mockResolvedValue(result),
  } as unknown as LibraryGateway;
  const events: Event[] = [];
  const listener = (event: Event) => events.push(event);
  window.addEventListener(ALBUM_AUTHORITY_CHANGED_EVENT, listener);
  return { gateway, events, stop: () => window.removeEventListener(ALBUM_AUTHORITY_CHANGED_EVENT, listener) };
}

it("announces a pass that only rematerialized a deferred membership", async () => {
  const { gateway, events, stop } = harness(reconciliation({ rematerializedMemberships: 2 }));
  const { unmount } = renderHook(() => useAlbumAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileAlbumAuthority).toHaveBeenCalled());
  // The relation is already written to `asset_albums`, so React's cached gallery is
  // stale even though no change row was applied and no baseline was adopted.
  await waitFor(() => expect(events.length).toBeGreaterThan(0));
  unmount();
  stop();
});

it("stays silent when a pass changed no visible Album state", async () => {
  const { gateway, events, stop } = harness(reconciliation({}));
  const { unmount } = renderHook(() => useAlbumAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.reconcileAlbumAuthority).toHaveBeenCalled());
  // A poll that converged nothing must not churn the UI.
  await act(async () => {
    await Promise.resolve();
  });
  expect(events).toHaveLength(0);
  unmount();
  stop();
});

it("announces applied change rows and baseline adoption as before", async () => {
  for (const result of [
    reconciliation({ appliedChanges: 3 }),
    reconciliation({ adoptedBaseline: true }),
  ]) {
    const { gateway, events, stop } = harness(result);
    const { unmount } = renderHook(() => useAlbumAuthoritySync(gateway, "test"));
    await waitFor(() => expect(events.length).toBeGreaterThan(0));
    unmount();
    stop();
  }
});

it("still announces nothing while the outbox is blocked", async () => {
  const gateway = {
    flushAlbumOutbox: vi.fn().mockResolvedValue({ ...flush, blocked: 1, pending: 1, stopped: true }),
    reconcileAlbumAuthority: vi.fn().mockResolvedValue(reconciliation({ rematerializedMemberships: 1 })),
  } as unknown as LibraryGateway;
  const events: Event[] = [];
  const listener = (event: Event) => events.push(event);
  window.addEventListener(ALBUM_AUTHORITY_CHANGED_EVENT, listener);
  const { unmount } = renderHook(() => useAlbumAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.flushAlbumOutbox).toHaveBeenCalled());
  // A blocked queue means receive never ran, so there is nothing to announce.
  expect(gateway.reconcileAlbumAuthority).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
  unmount();
  window.removeEventListener(ALBUM_AUTHORITY_CHANGED_EVENT, listener);
});
