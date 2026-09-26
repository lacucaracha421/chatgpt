import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionTrackingGateway } from "../library/types";
import { invalidateReleaseData, resetReleaseDataForTests, useReleaseData } from "./releaseData";

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
