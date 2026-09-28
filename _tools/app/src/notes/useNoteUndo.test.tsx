import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNoteUndo } from "./useNoteUndo";

afterEach(() => vi.useRealTimers());

it("groups typing by field, separates fields, and redoes through the supplied applier", () => {
  const applied: Array<[string, unknown]> = [];
  const { result, rerender } = renderHook(({ id }) => useNoteUndo(id, (field, value) => applied.push([field, value])), { initialProps: { id: "a" } });
  act(() => { result.current.record("title", "", "하"); result.current.record("title", "하", "하루"); });
  expect(result.current.canUndo).toBe(true);
  act(() => result.current.record("body", "", "본문"));
  act(() => result.current.undo());
  expect(applied).toEqual([["body", ""]]);
  act(() => result.current.undo());
  expect(applied).toEqual([["body", ""], ["title", ""]]);
  act(() => result.current.redo());
  expect(applied).toEqual([["body", ""], ["title", ""], ["title", "하루"]]);
  rerender({ id: "b" });
  expect(result.current.canUndo).toBe(false);
});

it("starts a new step after the typing window", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useNoteUndo("a", vi.fn()));
  act(() => result.current.record("body", "", "하"));
  act(() => { vi.advanceTimersByTime(601); result.current.record("body", "하", "하루"); });
  act(() => result.current.undo());
  expect(result.current.canUndo).toBe(true);
});
