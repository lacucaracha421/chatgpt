import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { ASSET_LIFECYCLE_CHANGED_EVENT, useAssetAuthoritySync } from "./useAssetAuthoritySync";

const idle = { adopted: true, appliedChanges: 0, materialized: 0, flushed: 0, stopped: false, materializationFailures: 0 };

function harness(result: typeof idle) {
  const gateway = { syncAssetAuthority: vi.fn().mockResolvedValue(result) } as unknown as LibraryGateway;
  const events: Event[] = [];
  const listener = (event: Event) => events.push(event);
  window.addEventListener(ASSET_LIFECYCLE_CHANGED_EVENT, listener);
  return { gateway, events, stop: () => window.removeEventListener(ASSET_LIFECYCLE_CHANGED_EVENT, listener) };
}

it("announces a remote lifecycle change so the trash count refreshes", async () => {
  const { gateway, events, stop } = harness({ ...idle, appliedChanges: 1 });
  const { unmount } = renderHook(() => useAssetAuthoritySync(gateway, "test"));
  await waitFor(() => expect(events).toHaveLength(1));
  unmount();
  stop();
});

it("stays quiet when nothing changed", async () => {
  const { gateway, events, stop } = harness(idle);
  const { unmount } = renderHook(() => useAssetAuthoritySync(gateway, "test"));
  await waitFor(() => expect(gateway.syncAssetAuthority).toHaveBeenCalled());
  await Promise.resolve();
  expect(events).toHaveLength(0);
  unmount();
  stop();
});
