import { act, cleanup, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvLinkInbox, useAvLinkInbox, useAvLinkPendingCount, type AvLinkApi } from "./AvLinkInbox";
import type { AvLinkInboxItem } from "./avLinkClient";

const item = (id: string, status: AvLinkInboxItem["status"], extra: Partial<AvLinkInboxItem> = {}): AvLinkInboxItem => ({
  id, requestId: `request-${id}`, productCode: `CODE-${id}`, normalizedCode: `CODE-${id}`, sourceUrl: null,
  receivedAt: "2026-09-27T05:02:00Z", status, attempts: 0, lastError: null, fetchedAt: null,
  collectionId: null, collectionName: null, ...extra,
});

function api(overrides: Partial<AvLinkApi> = {}) {
  return {
    listInbox: vi.fn().mockResolvedValue([]), pendingCount: vi.fn().mockResolvedValue(0), getCandidate: vi.fn(),
    retry: vi.fn().mockResolvedValue(undefined), fixCode: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined), apply: vi.fn(), ...overrides,
  } as AvLinkApi;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AvLinkInbox", () => {
  it("shows received times with the shared clock format and an invalid-time fallback", () => {
    render(<AvLinkInbox items={[
      item("valid", "found", { receivedAt: "2026-09-27T00:02:00" }),
      item("invalid", "found", { receivedAt: "invalid" }),
    ]} collections={[]} api={api()} onRefresh={vi.fn()} onCollectionsChanged={vi.fn()} />);
    expect(screen.getByText("00:02")).toBeInTheDocument();
    expect(screen.getByText("--:--")).toBeInTheDocument();
  });

  it("is absent when no non-final inbox item remains", () => {
    render(<AvLinkInbox items={[]} collections={[]} api={api()} onRefresh={vi.fn()} onCollectionsChanged={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "받은 품번" })).not.toBeInTheDocument();
  });

  it("retries, fixes, and discards rows through the matching client calls", async () => {
    const client = api();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AvLinkInbox items={[item("miss", "not_found"), item("found", "found", { collectionId: "av-1", collectionName: "기존 작품" })]}
      collections={[]} api={client} onRefresh={refresh} onCollectionsChanged={vi.fn()} />);
    const user = userEvent.setup();

    const missing = screen.getByText("CODE-miss").closest(".av-link-row") as HTMLElement;
    await user.click(within(missing).getByRole("button", { name: /다시 시도/ }));
    expect(client.retry).toHaveBeenCalledWith("miss");
    await user.click(within(missing).getByRole("button", { name: "품번 고치기" }));
    const input = within(missing).getByRole("textbox", { name: "품번" });
    await user.clear(input); await user.type(input, "NEW-101");
    await user.click(within(missing).getByRole("button", { name: "저장" }));
    expect(client.fixCode).toHaveBeenCalledWith("miss", "NEW-101");

    await user.click(screen.getByRole("button", { name: "CODE-found 버리기" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(client.dismiss).toHaveBeenCalledWith("found");
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

it("ignores a pending count after privacy is enabled, including a later re-enable", async () => {
  let resolve!: (value: number) => void;
  const client = api({pendingCount: vi.fn().mockReturnValueOnce(new Promise<number>(yes => { resolve = yes; })).mockResolvedValue(2)});
  const {result, rerender} = renderHook(({enabled}) => useAvLinkPendingCount({enabled, api: client}), {initialProps: {enabled: true}});
  rerender({enabled: false});
  await act(async () => { resolve(9); });
  expect(result.current).toBe(0);
  rerender({enabled: true});
  await act(async () => {});
  expect(result.current).toBe(2);
});

it("ignores an older pending count even after privacy is turned off again", async () => {
  let resolve!: (value: number) => void;
  const client = api({pendingCount: vi.fn().mockReturnValueOnce(new Promise<number>(yes => { resolve = yes; })).mockResolvedValue(2)});
  const {result, rerender} = renderHook(({enabled}) => useAvLinkPendingCount({enabled, api: client}), {initialProps: {enabled: true}});
  rerender({enabled: false});
  rerender({enabled: true});
  await act(async () => {});
  expect(result.current).toBe(2);
  await act(async () => { resolve(9); });
  expect(result.current).toBe(2);
});

describe("AvLinkInbox on the server inbox", () => {
  it("shows a choice being written, a stopped one and a refused one without offering other actions", async () => {
    const client = api();
    render(<AvLinkInbox items={[
      item("a", "found", { applyState: "applying" }),
      item("b", "found", { applyState: "blocked" }),
      item("c", "found", { applyState: "failed" }),
    ]} collections={[]} api={client} onRefresh={vi.fn()} onCollectionsChanged={vi.fn()} />);
    const writing = screen.getByText("CODE-a").closest(".av-link-row") as HTMLElement;
    expect(within(writing).getByText("보내는 중")).toBeInTheDocument();
    expect(within(writing).queryByRole("button", { name: "후보 보기" })).not.toBeInTheDocument();
    expect(within(writing).getByRole("button", { name: "CODE-a 버리기" })).toBeDisabled();
    const stopped = screen.getByText("CODE-b").closest(".av-link-row") as HTMLElement;
    expect(within(stopped).getByText("멈춤")).toBeInTheDocument();
    expect(within(stopped).getByText(/서버에서 막힌 변경/)).toBeInTheDocument();
    expect(within(stopped).queryByRole("button", { name: "후보 보기" })).not.toBeInTheDocument();
    // A refused earlier attempt can be looked at again.
    const refused = screen.getByText("CODE-c").closest(".av-link-row") as HTMLElement;
    expect(within(refused).getByText("지난 적용이 거절됐어요")).toBeInTheDocument();
    await userEvent.setup().click(within(refused).getByRole("button", { name: "후보 보기" }));
    expect(client.getCandidate).toHaveBeenCalledWith("c", undefined);
  });

  it("asks the user to pick when several collections share the code", () => {
    render(<AvLinkInbox items={[
      item("m", "found", { matches: [{ collectionId: "a", name: "A" }, { collectionId: "b", name: "B" }] }),
    ]} collections={[]} api={api()} onRefresh={vi.fn()} onCollectionsChanged={vi.fn()} />);
    expect(screen.getByText("같은 품번의 컬렉션이 2개 있어요")).toBeInTheDocument();
    expect(screen.queryByText("새 AV 컬렉션 만들기")).not.toBeInTheDocument();
  });

  it("keeps the old rows on screen while a re-read is pending and keeps polling while a choice is written", async () => {
    vi.useFakeTimers();
    try {
      let resolveSecond!: (value: AvLinkInboxItem[]) => void;
      const listInbox = vi.fn()
        .mockResolvedValueOnce([item("a", "found", { applyState: "applying" })])
        .mockReturnValueOnce(new Promise<AvLinkInboxItem[]>(yes => { resolveSecond = yes; }));
      const client = api({ listInbox });
      const { result } = renderHook(() => useAvLinkInbox({ poll: true, api: client }));
      await act(async () => {});
      expect(result.current.items).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(listInbox).toHaveBeenCalledTimes(2);
      // The pending re-read does not blank the list.
      expect(result.current.items).toHaveLength(1);
      await act(async () => { resolveSecond([]); });
      expect(result.current.items).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});
