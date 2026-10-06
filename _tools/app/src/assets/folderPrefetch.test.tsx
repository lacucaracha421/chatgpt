import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetView } from "../library/types";
import {
  FOLDER_PREFETCH_DWELL_MS, FOLDER_PREFETCH_FRESH_MS, FolderPrefetchContext, invalidateFolderPrefetch, prefetchRead, prefetchedRead,
  resetFolderPrefetch, useFolderPrefetchIntent, type FolderPrefetchPlan,
} from "./folderPrefetch";

const api = { read: vi.fn<(id: string) => Promise<string>>() };
const folder = (id: string): AssetView => ({ kind: "classification", classificationId: id });
const plan = vi.fn<FolderPrefetchPlan>(view => view.kind === "classification" && view.classificationId
  ? [prefetchRead(api, "read", view.classificationId, () => api.read(view.classificationId!))] : null);
const switchRead = (id: string) => prefetchedRead(api, "read", id, () => api.read(id));

function Folders({ ids }: { ids: string[] }) {
  const intent = useFolderPrefetchIntent();
  return <>{ids.map(id => <button key={id} {...intent(folder(id))}>{id}</button>)}</>;
}
const renderFolders = (...ids: string[]) => render(<FolderPrefetchContext.Provider value={{ current: plan }}><Folders ids={ids} /></FolderPrefetchContext.Provider>);
const enter = (id: string, init: PointerEventInit = { pointerType: "mouse" }) => fireEvent.pointerEnter(screen.getByRole("button", { name: id }), init);
const leave = (id: string) => fireEvent.pointerLeave(screen.getByRole("button", { name: id }), { pointerType: "mouse" });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  api.read.mockReset().mockImplementation(async id => `page ${id}`);
  plan.mockClear();
});
afterEach(() => { cleanup(); resetFolderPrefetch(); vi.useRealTimers(); });

it("does not read when the pointer leaves before the dwell", () => {
  renderFolders("a");
  enter("a");
  act(() => { vi.advanceTimersByTime(FOLDER_PREFETCH_DWELL_MS - 1); });
  leave("a");
  act(() => { vi.advanceTimersByTime(1000); });
  expect(plan).not.toHaveBeenCalled();
  expect(api.read).not.toHaveBeenCalled();
});

it("reads once after the dwell, and the switch takes that result instead of reading again", async () => {
  renderFolders("a");
  enter("a");
  act(() => { vi.advanceTimersByTime(FOLDER_PREFETCH_DWELL_MS); });
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(api.read).toHaveBeenCalledWith("a");
  await expect(switchRead("a")).resolves.toBe("page a");
  expect(api.read).toHaveBeenCalledTimes(1);
  // One-shot: a later reload of the same folder reads normally.
  await expect(switchRead("a")).resolves.toBe("page a");
  expect(api.read).toHaveBeenCalledTimes(2);
});

it("keeps one prefetch in flight; only the latest hovered folder starts after it", async () => {
  let finish!: (value: string) => void;
  api.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  renderFolders("a", "b", "c");
  enter("a");
  act(() => { vi.advanceTimersByTime(FOLDER_PREFETCH_DWELL_MS); });
  leave("a"); enter("b");
  act(() => { vi.advanceTimersByTime(FOLDER_PREFETCH_DWELL_MS); });
  leave("b"); enter("c");
  act(() => { vi.advanceTimersByTime(FOLDER_PREFETCH_DWELL_MS); });
  expect(api.read.mock.calls).toEqual([["a"]]);
  finish("page a");
  await flush();
  expect(api.read.mock.calls).toEqual([["a"], ["c"]]);
});

it("shares a taken prefetch with synchronous mount-effect replay, then consumes it once", async () => {
  void prefetchRead(api, "read", "a", () => api.read("a"));
  const first = switchRead("a"), replay = switchRead("a");
  await expect(Promise.all([first, replay])).resolves.toEqual(["page a", "page a"]);
  expect(api.read).toHaveBeenCalledTimes(1);
  await switchRead("a");
  expect(api.read).toHaveBeenCalledTimes(2);
});

it("drops a waiting hover when the pointer leaves it", async () => {
  let finish!: (value: string) => void;
  api.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  renderFolders("a", "b");
  enter("a");
  act(() => { vi.advanceTimersByTime(FOLDER_PREFETCH_DWELL_MS); });
  leave("a"); enter("b");
  act(() => { vi.advanceTimersByTime(FOLDER_PREFETCH_DWELL_MS); });
  leave("b");
  finish("page a");
  await flush();
  expect(api.read.mock.calls).toEqual([["a"]]);
});

it("never prefetches for touch, pen or a pressed mouse button", () => {
  renderFolders("a");
  enter("a", { pointerType: "touch" });
  enter("a", { pointerType: "pen" });
  enter("a", { pointerType: "mouse", buttons: 1 });
  act(() => { vi.advanceTimersByTime(1000); });
  expect(plan).not.toHaveBeenCalled();
  expect(api.read).not.toHaveBeenCalled();
});

it("reads normally after a library change, after the freshness window, or when the prefetch failed", async () => {
  void prefetchRead(api, "read", "a", () => api.read("a"));
  invalidateFolderPrefetch();
  await switchRead("a");
  expect(api.read).toHaveBeenCalledTimes(2);

  void prefetchRead(api, "read", "b", () => api.read("b"));
  vi.advanceTimersByTime(FOLDER_PREFETCH_FRESH_MS + 1);
  await switchRead("b");
  expect(api.read).toHaveBeenCalledTimes(4);

  api.read.mockRejectedValueOnce(new Error("busy"));
  void prefetchRead(api, "read", "c", () => api.read("c"));
  await expect(switchRead("c")).resolves.toBe("page c");
  expect(api.read).toHaveBeenCalledTimes(6);
});

it("keys a read by its exact arguments and API object", async () => {
  const other = { read: vi.fn(async () => "other") };
  void prefetchRead(api, "browse", { seriesId: "s", limit: 100, after: null }, () => api.read("s"));
  await prefetchedRead(other, "browse", { seriesId: "s", limit: 100, after: null }, other.read);
  expect(other.read).toHaveBeenCalledTimes(1);
  await prefetchedRead(api, "browse", { seriesId: "s", limit: 50, after: null }, () => api.read("s"));
  expect(api.read).toHaveBeenCalledTimes(2);
  // Property order does not matter.
  await prefetchedRead(api, "browse", { after: null, limit: 100, seriesId: "s" }, () => api.read("s"));
  expect(api.read).toHaveBeenCalledTimes(2);
});

it("drops only the reads tagged with a folder whose members changed", async () => {
  const listener = vi.fn();
  const { onFolderPrefetchInvalidated } = await import("./folderPrefetch");
  const stop = onFolderPrefetchInvalidated(listener);
  prefetchRead(api, "read", "a", () => api.read("a"), "a");
  prefetchRead(api, "read", "b", () => api.read("b"), "b");
  prefetchRead(api, "read", "plain", () => api.read("plain"));
  expect(api.read).toHaveBeenCalledTimes(3);
  invalidateFolderPrefetch("a");
  // The mount-wide revision caches (suggestions, counts) are not cleared for a member change.
  expect(listener).not.toHaveBeenCalled();
  await switchRead("a");
  await switchRead("b");
  await switchRead("plain");
  expect(api.read.mock.calls.map(([id]) => id)).toEqual(["a", "b", "plain", "a"]);
  stop();
});
