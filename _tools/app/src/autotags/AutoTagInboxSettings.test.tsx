import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { AutoTagSettings } from "./AutoTagSettings";
import { autoTagInboxResult, type AutoTagInbox } from "./autoTagInbox";
import { useAutoTagInboxStatus } from "./useAutoTagInboxStatus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../app/workloadProfile", () => ({ nativeWorkload: () => true }));
vi.mock("../library/LibraryContext", () => ({ useLibrary: () => ({ gateway: { autoTags: { importSummary: () => Promise.resolve(null) } } }) }));

let settings: AutoTagInbox;
const initial = (): AutoTagInbox => ({
  folder: "/tmp/inbox", applyTaggerReview: true,
  last: {
    "auto-tags-latest.sqlite": { fileModified: "123", fileSize: 10, importedAt: "2026-09-28T03:40:00+09:00", imported: { taggedAssets: 42, tagRows: 100, skippedAssets: 0 }, tagger: { veto: 4, recommend: 8 }, error: null },
    "artist-style-latest.sqlite": { fileModified: "124", fileSize: 20, importedAt: "2026-09-28T03:40:00+09:00", imported: { imported: 8960, skipped: 0 }, tagger: null, error: null },
    "nl-search-latest.sqlite": { fileModified: "125", fileSize: 30, importedAt: "2026-09-28T03:40:00+09:00", imported: { siglip: 9103, qwen8b: 9103, skipped: 0 }, tagger: null, error: null },
  },
});
beforeEach(() => {
  vi.clearAllMocks(); settings = initial();
  vi.mocked(listen).mockResolvedValue(vi.fn());
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_auto_tag_inbox") return settings;
    if (command === "set_auto_tag_inbox") {
      settings = { ...settings, ...(args as object) }; return settings;
    }
    if (command === "run_auto_tag_inbox_now") return { settings, processed: [], skipped: null };
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(cleanup);

it("renders the nightly result and chooses the folder, review toggle and manual trigger", async () => {
  const user = userEvent.setup();
  render(<AutoTagSettings disabled={false} />);
  expect(await screen.findByText(/태거 판정 12건 반영.*그림체 8,960장.*내용 검색 색인 9,103장/)).toBeTruthy();
  expect(screen.getByText("/tmp/inbox")).toBeTruthy();
  await user.click(screen.getByRole("switch", { name: "가져온 뒤 태거 판정 자동 반영" }));
  expect(invoke).toHaveBeenCalledWith("set_auto_tag_inbox", { folder: "/tmp/inbox", applyTaggerReview: false });
  vi.mocked(open).mockResolvedValue("/tmp/daily");
  await user.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
  expect(invoke).toHaveBeenCalledWith("set_auto_tag_inbox", { folder: "/tmp/daily", applyTaggerReview: false });
  await user.click(screen.getByRole("button", { name: "지금 가져오기" }));
  expect(invoke).toHaveBeenCalledWith("run_auto_tag_inbox_now");
  expect(await screen.findByText("새로 가져올 파일이 없습니다.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "사용 안 함" }));
  expect(invoke).toHaveBeenCalledWith("set_auto_tag_inbox", { folder: null, applyTaggerReview: false });
});

it("shows failed file results and preserves configuration when a run is busy", async () => {
  const user = userEvent.setup();
  settings.last!["auto-tags-latest.sqlite"].error = "자동 태그 파일 형식이 아닙니다";
  expect(autoTagInboxResult(settings)).toContain("자동 태그 가져오기 실패 · 자동 태그 파일 형식이 아닙니다");
  vi.mocked(invoke).mockImplementation(async command => command === "run_auto_tag_inbox_now"
    ? { settings: { folder: null, applyTaggerReview: true, last: null }, processed: [], skipped: "다른 가져오기가 진행 중입니다." }
    : settings);
  render(<AutoTagSettings disabled={false} />);
  await screen.findByText(/자동 태그 가져오기 실패/);
  await user.click(screen.getByRole("button", { name: "지금 가져오기" }));
  expect(await screen.findByText("다른 가져오기가 진행 중입니다.")).toBeTruthy();
  expect(screen.getByText("/tmp/inbox")).toBeTruthy();
});

it("refreshes settings after a background completion and disables actions while unavailable", async () => {
  const view = render(<AutoTagSettings disabled />);
  await screen.findByText("/tmp/inbox");
  expect((screen.getByRole("button", { name: "지금 가져오기" }) as HTMLButtonElement).disabled).toBe(true);
  settings = { folder: "/tmp/new", applyTaggerReview: false, last: null };
  const handler = vi.mocked(listen).mock.calls[0][1];
  await act(async () => { handler({ event: "library://auto-tag-inbox", id: 1, payload: {} }); });
  expect(await screen.findByText("/tmp/new")).toBeTruthy();
  view.unmount();
});

it("keeps background success and errors in the shell status until dismissed", async () => {
  const { result } = renderHook(useAutoTagInboxStatus);
  await waitFor(() => expect(listen).toHaveBeenCalled());
  const handler = vi.mocked(listen).mock.calls[0][1];
  act(() => handler({ event: "library://auto-tag-inbox", id: 1, payload: { message: "태거 판정 12건 반영", error: false } }));
  expect(result.current.status?.message).toBe("태거 판정 12건 반영");
  act(() => handler({ event: "library://auto-tag-inbox", id: 1, payload: { message: "그림체 가져오기 실패", error: true } }));
  expect(result.current.status?.error).toBe(true);
  act(() => result.current.dismiss());
  expect(result.current.status).toBeNull();
});

it("leaves inbox cadence to the native owner and handles completion events without a catch-up timer", async () => {
  vi.useFakeTimers();
  try {
    const hook = renderHook(useAutoTagInboxStatus);
    await act(async () => { await Promise.resolve(); });
    const callback = vi.mocked(listen).mock.calls.find(([name]) => name === "library://auto-tag-inbox")![1];
    for (const seconds of [120, 300, 3600]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(seconds * 1000); });
      expect(invoke).not.toHaveBeenCalledWith("run_auto_tag_inbox_now");
    }
    act(() => callback({ payload: { message: "가져오기 완료", error: false } } as never));
    expect(hook.result.current.status).toEqual({ message: "가져오기 완료", error: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(3600_000); });
    expect(invoke).not.toHaveBeenCalledWith("run_auto_tag_inbox_now");
  } finally { vi.useRealTimers(); }
});
