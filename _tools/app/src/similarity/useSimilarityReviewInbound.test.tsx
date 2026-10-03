import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { SIMILARITY_REVIEW_CHANGED_EVENT, useSimilarityReviewInbound } from "./useSimilarityReviewInbound";

beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); });

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("slows visible unfocused polling and preserves the baseline across focus changes", async () => {
  vi.useFakeTimers();
  let applied = 2;
  const read = vi.fn(async () => ({ applied }));
  const onChange = vi.fn();
  const gateway = { similarityReviewInboundStatus: read } as unknown as LibraryGateway;
  const { unmount } = renderHook(() => useSimilarityReviewInbound(gateway, onChange));
  await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(read).toHaveBeenCalledTimes(2);
  act(() => window.dispatchEvent(new Event("blur")));
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(read).toHaveBeenCalledTimes(3);
  applied = 3;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(4);
  expect(onChange).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(read).toHaveBeenCalledTimes(5);
  unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(5);
});

it("announces each change after the baseline reading", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const similarityReviewInboundStatus = vi.fn()
    .mockResolvedValueOnce({ applied: 2 })
    .mockResolvedValueOnce({ applied: 2 })
    .mockResolvedValue({ applied: 3 });
  const gateway = { similarityReviewInboundStatus } as unknown as LibraryGateway;
  const onChange = vi.fn();
  const events: Event[] = [];
  const listener = (event: Event) => events.push(event);
  window.addEventListener(SIMILARITY_REVIEW_CHANGED_EVENT, listener);
  const { unmount } = renderHook(() => useSimilarityReviewInbound(gateway, onChange));

  await waitFor(() => expect(similarityReviewInboundStatus).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(similarityReviewInboundStatus).toHaveBeenCalledTimes(2);
  expect(onChange).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  expect(events).toHaveLength(1);

  unmount();
  window.removeEventListener(SIMILARITY_REVIEW_CHANGED_EVENT, listener);
});

it("does nothing without the native command", () => {
  const onChange = vi.fn();
  const { unmount } = renderHook(() => useSimilarityReviewInbound({} as LibraryGateway, onChange));
  unmount();
  expect(onChange).not.toHaveBeenCalled();
});
