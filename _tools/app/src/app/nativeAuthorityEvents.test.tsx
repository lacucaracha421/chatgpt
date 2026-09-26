import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";

const handlers = new Map<string, () => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => undefined)) }));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  handlers.clear();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.useRealTimers();
});

const polling = () => ({
  flushAlbumOutbox: vi.fn(), reconcileAlbumAuthority: vi.fn(),
  flushClassificationOutbox: vi.fn(), reconcileClassificationAuthority: vi.fn(),
  flushCatalogBookmarkOutbox: vi.fn(), reconcileCatalogBookmarks: vi.fn(),
}) as unknown as LibraryGateway & Record<string, ReturnType<typeof vi.fn>>;

it("the desktop app sends no per-domain polls from React and relays the native pass's changes", async () => {
  const { useAlbumAuthoritySync, ALBUM_AUTHORITY_CHANGED_EVENT } = await import("./useAlbumAuthoritySync");
  const { useClassificationAuthoritySync, CLASSIFICATION_AUTHORITY_CHANGED_EVENT } = await import("./useClassificationAuthoritySync");
  const { useCatalogBookmarkSync, CATALOG_BOOKMARKS_CHANGED_EVENT } = await import("./useCatalogBookmarkSync");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const gateway = polling();
  const seen: string[] = [];
  const events = [ALBUM_AUTHORITY_CHANGED_EVENT, CLASSIFICATION_AUTHORITY_CHANGED_EVENT, CATALOG_BOOKMARKS_CHANGED_EVENT];
  const record = (event: Event) => seen.push(event.type);
  events.forEach(name => window.addEventListener(name, record));
  const { unmount } = renderHook(() => {
    useAlbumAuthoritySync(gateway, "root");
    useClassificationAuthoritySync(gateway, "root");
    useCatalogBookmarkSync(gateway, "root");
  });
  const relays = () => [...handlers.keys()].filter(name => name.startsWith("library://"));
  await waitFor(() => expect(relays()).toHaveLength(3));
  await vi.advanceTimersByTimeAsync(120_000);
  window.dispatchEvent(new Event("focus"));
  for (const method of Object.values(gateway)) expect(method).not.toHaveBeenCalled();
  handlers.get("library://album-authority-changed")!();
  handlers.get("library://classification-authority-changed")!();
  handlers.get("library://catalog-bookmarks-changed")!();
  expect(seen).toEqual(events);
  unmount();
  expect(relays()).toHaveLength(0);
  events.forEach(name => window.removeEventListener(name, record));
});

it("the desktop app does not turn a window focus into Asset change events", async () => {
  const { useAssetAuthoritySync, ASSET_LIFECYCLE_CHANGED_EVENT } = await import("./useAssetAuthoritySync");
  const { ALBUM_AUTHORITY_CHANGED_EVENT } = await import("./useAlbumAuthoritySync");
  const { CLASSIFICATION_AUTHORITY_CHANGED_EVENT } = await import("./useClassificationAuthoritySync");
  const gateway = { syncAssetAuthority: vi.fn() } as unknown as LibraryGateway;
  const seen: string[] = [];
  const events = [CLASSIFICATION_AUTHORITY_CHANGED_EVENT, ALBUM_AUTHORITY_CHANGED_EVENT, ASSET_LIFECYCLE_CHANGED_EVENT];
  const record = (event: Event) => seen.push(event.type);
  events.forEach(name => window.addEventListener(name, record));
  const { unmount } = renderHook(() => useAssetAuthoritySync(gateway, "root"));
  await waitFor(() => expect(handlers.has("library://asset-authority-changed")).toBe(true));
  window.dispatchEvent(new Event("focus"));
  expect(seen).toEqual([]);
  expect(gateway.syncAssetAuthority).not.toHaveBeenCalled();
  // A real native change still refreshes all three views.
  handlers.get("library://asset-authority-changed")!();
  expect(seen).toEqual(events);
  unmount();
  events.forEach(name => window.removeEventListener(name, record));
});
