import { StrictMode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusyLabel } from "./BusyLabel";
import { useDelayedBusy } from "../useDelayedBusy";

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
describe("shared busy presentation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it("disables immediately while keeping the normal label for quick work", () => {
    const button = (busy: boolean) => <button disabled={busy}><BusyLabel busy={busy} idle="저장">저장 중…</BusyLabel></button>;
    const view = render(button(false));
    view.rerender(button(true));
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    advance(599); view.rerender(button(false)); advance(1000);
    expect(screen.queryByText("저장 중…")).toBeNull();
    expect(screen.getByRole("button", { name: "저장" })).not.toBeDisabled();
  });
  it("retains the busy text until its minimum expires, then shows the result directly", () => {
    const view = render(<BusyLabel busy idle="이전 상태">저장 중…</BusyLabel>);
    advance(600); expect(screen.getByText("저장 중…")).toBeTruthy();
    view.rerender(<BusyLabel busy={false} idle="저장됨">다음 작업</BusyLabel>);
    advance(399); expect(screen.getByText("저장 중…")).toBeTruthy();
    advance(1); expect(screen.getByText("저장됨")).toBeTruthy();
    expect(screen.queryByText("다음 작업")).toBeNull();
  });
  it("survives StrictMode effect replay when initially busy", () => {
    render(<StrictMode><BusyLabel busy>확인 중…</BusyLabel></StrictMode>);
    advance(599); expect(screen.queryByText("확인 중…")).toBeNull();
    advance(1); expect(screen.getByText("확인 중…")).toBeTruthy();
  });
  it("keeps the previous settled status while the next operation is still below the delay", () => {
    const view = render(<BusyLabel busy={false} idle="켜짐">저장 중…</BusyLabel>);
    view.rerender(<BusyLabel busy idle="꺼짐">저장 중…</BusyLabel>);
    advance(500); expect(screen.getByText("켜짐")).toBeTruthy();
    expect(screen.queryByText("꺼짐")).toBeNull();
    view.rerender(<BusyLabel busy={false} idle="꺼짐">저장 중…</BusyLabel>);
    expect(screen.getByText("꺼짐")).toBeTruthy();
  });
  it("keeps the same visible interval when work resumes", () => {
    const { result, rerender } = renderHook(({ busy }) => useDelayedBusy(busy), { initialProps: { busy: true } });
    advance(650); rerender({ busy: false }); advance(100); rerender({ busy: true }); advance(500);
    expect(result.current).toBe(true);
    rerender({ busy: false }); expect(result.current).toBe(false);
  });
  it("supports the profile editor's 400 ms delay", () => {
    render(<BusyLabel busy delay={400} idle="저장">저장 중</BusyLabel>);
    advance(399); expect(screen.getByText("저장")).toBeTruthy();
    advance(1); expect(screen.getByText("저장 중")).toBeTruthy();
  });
  it("cancels callbacks when unmounted", () => {
    const { unmount } = renderHook(() => useDelayedBusy(true));
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("applies new timing options without keeping an obsolete timer", () => {
    const { result, rerender } = renderHook(({ delay }) => useDelayedBusy(true, { delay, minVisible: 100 }), { initialProps: { delay: 600 } });
    advance(500); rerender({ delay: 200 }); advance(199); expect(result.current).toBe(false);
    advance(1); expect(result.current).toBe(true);
  });
});
