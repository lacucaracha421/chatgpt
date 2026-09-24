import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { SIMILARITY_REVIEW_CHANGED_EVENT, useSimilarityReviewInbound } from "./useSimilarityReviewInbound";

afterEach(() => vi.useRealTimers());

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
