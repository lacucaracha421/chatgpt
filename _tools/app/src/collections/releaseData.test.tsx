import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionTrackingGateway, ReleaseInboxItem } from "../library/types";
import { acknowledgeReleaseItems, invalidateReleaseData, resetReleaseDataForTests, useReleaseData } from "./releaseData";

afterEach(() => { cleanup(); resetReleaseDataForTests(); });

const api = () => ({ listInbox: vi.fn().mockResolvedValue([]), releaseBoard: vi.fn().mockResolvedValue([]) }) as unknown as CollectionTrackingGateway;

it("reads once per Collection list and keeps the data across remounts", async () => {
  const tracking = api();
  const list = [{ id: "a" }];
  const first = renderHook(() => useReleaseData(tracking, list, true));
  await waitFor(() => expect(first.result.current.data).not.toBeNull());
  first.unmount();
  const again = renderHook(() => useReleaseData(tracking, list, true));
  expect(again.result.current.data).not.toBeNull();
  expect(tracking.releaseBoard).toHaveBeenCalledTimes(1);
  expect(tracking.listInbox).toHaveBeenCalledTimes(1);
});

it("reads again when the Collection list is replaced or the data is invalidated, keeping the old data meanwhile", async () => {
  const tracking = api();
  let list = [{ id: "a" }];
  const view = renderHook(() => useReleaseData(tracking, list, true));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  list = [{ id: "a" }];
  view.rerender();
  expect(view.result.current.data).not.toBeNull();
  await waitFor(() => expect(tracking.releaseBoard).toHaveBeenCalledTimes(2));
  // An owned count or 신간 알림 edit does not replace the list.
  act(() => invalidateReleaseData());
  await waitFor(() => expect(tracking.releaseBoard).toHaveBeenCalledTimes(3));
});

it("does not read while disabled", () => {
  const tracking = api();
  renderHook(() => useReleaseData(tracking, [], false));
  expect(tracking.listInbox).not.toHaveBeenCalled();
});

it("keeps confirmed exact events hidden across stale reads without hiding later events", async () => {
  const tracking = api();
  const first = { collectionId: "a", event: { id: "first" } } as ReleaseInboxItem;
  const later = { collectionId: "a", event: { id: "later" } } as ReleaseInboxItem;
  tracking.acknowledge = vi.fn().mockResolvedValue(undefined);
  vi.mocked(tracking.listInbox).mockResolvedValue([first]);
  const source = {};
  const view = renderHook(() => useReleaseData(tracking, source, true));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  await act(async () => acknowledgeReleaseItems(tracking, [first]));
  expect(view.result.current.data?.inbox).toEqual([]);
  expect(tracking.listInbox).toHaveBeenCalledTimes(1);
  vi.mocked(tracking.listInbox).mockResolvedValue([first, later]);
  act(() => invalidateReleaseData());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.data?.inbox).toEqual([later]);
});

it("restores only the failed acknowledgement when different works are confirmed concurrently", async () => {
  const tracking = api();
  const items = ["a", "b"].map(collectionId => ({ collectionId, event: { id: collectionId } }) as ReleaseInboxItem);
  vi.mocked(tracking.listInbox).mockResolvedValue(items);
  let fail!: (error: Error) => void;
  tracking.acknowledge = vi.fn().mockImplementation((id: string) => id === "a" ? new Promise<void>((_resolve, reject) => { fail = reject; }) : Promise.resolve());
  const source = {};
  const view = renderHook(() => useReleaseData(tracking, source, true));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let failed!: Promise<unknown>;
  act(() => { failed = acknowledgeReleaseItems(tracking, [items[0]!]).catch(error => error); });
  await act(async () => acknowledgeReleaseItems(tracking, [items[1]!]));
  expect(view.result.current.data?.inbox).toEqual([]);
  await act(async () => { fail(new Error("save failed")); await failed; });
  expect(view.result.current.data?.inbox).toEqual([items[0]]);
  expect(tracking.listInbox).toHaveBeenCalledTimes(1);
});
