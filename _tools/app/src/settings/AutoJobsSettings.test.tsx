import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { libraryGateway } from "../library/client";
import type { AutoJobId, AutoJobStatus, LibraryGateway } from "../library/types";
import { AutoJobsSettings, AutoJobsSummary, useAutoJobs } from "./AutoJobsSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../app/workloadProfile", () => ({ useWorkloadProfile: () => ({ lightweight: true }), updateWorkloadSettings: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

function job(id: AutoJobId, overrides: Partial<AutoJobStatus> = {}): AutoJobStatus {
  return { id, state: "idle", waitingReason: null, unconfiguredReason: null, enabled: null, lastRunAt: null, overdueSince: null, lastOk: null, lastError: null, lastCount: null, nextRunAt: null, intervalSeconds: null, progress: null, pending: null, failed: null, canStop: false, ...overrides };
}
function fixture(initial: AutoJobStatus[]) {
  let jobs = initial;
  const gateway: LibraryGateway = { ...libraryGateway,
    autoJobsStatus: vi.fn(async () => jobs),
    runAutoJob: vi.fn(async id => {
      const next = job(id, { ...jobs.find(item => item.id === id), state: "idle", lastOk: true, lastError: null, lastRunAt: new Date().toISOString(), lastCount: 4, pending: id === "trash" ? 0 : null });
      jobs = jobs.map(item => item.id === id ? next : item);
      return next;
    }),
    getTrashPolicy: vi.fn(async () => ({ retentionDays: 14 })),
    listTrash: vi.fn(async () => ({ items: [], nextCursor: null, totalCount: 45, totalBytes: 0 })),
  };
  return gateway;
}
function Harness({ gateway }: { gateway: LibraryGateway }) {
  const model = useAutoJobs(gateway, true);
  return <AutoJobsSettings gateway={gateway} model={model} onConfigure={vi.fn()} />;
}

it("shows quiet no-new-files feedback when a manual tag import leaves lastRunAt unchanged", async () => {
  const unchanged = job("autoTags", { lastRunAt: "2026-10-26T01:00:00Z", lastOk: true });
  const gateway = fixture([unchanged]);
  gateway.runAutoJob = vi.fn(async () => unchanged);
  render(<Harness gateway={gateway} />);
  await userEvent.click(await screen.findByRole("button", { name: "지금 실행" }));
  expect(await screen.findByText("새 파일 없음")).toBeVisible();
});

it("shows no-new-files feedback after the tag worker stops without a new import", async () => {
  const unchanged = job("autoTags", { lastRunAt: "2026-10-26T01:00:00Z", lastOk: true });
  const gateway = fixture([job("autoTags", { ...unchanged, overdueSince: "2026-10-26T03:00:00Z" })]);
  gateway.runAutoJob = vi.fn(async () => ({ ...unchanged, state: "running" as const }));
  render(<Harness gateway={gateway} />);
  await userEvent.click(await screen.findByRole("button", { name: "지금 실행" }));
  expect(await screen.findByText("새 파일 없음")).toBeVisible();
});

it("moves whole-job failures to the failure group and returns them after success, keeping partial failures in place", async () => {
  const gateway = fixture([job("releaseWatch", { state: "failed", lastOk: false, lastError: "MangaDex 응답 없음" }), job("cloudBackfill", { failed: 4, pending: 12 })]);
  render(<Harness gateway={gateway} />);
  const failed = await screen.findByRole("region", { name: "실패" });
  expect(within(failed).getByText("찜·신간 발매 확인")).toBeVisible();
  expect(within(screen.getByRole("region", { name: "준비" })).getByText("클라우드 복제")).toBeVisible();
  await userEvent.click(within(failed).getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "실패" })).toBeNull());
  expect(within(screen.getByRole("region", { name: "새 정보" })).getByText("찜·신간 발매 확인")).toBeVisible();
  expect(gateway.runAutoJob).toHaveBeenCalledWith("releaseWatch");
});

it("purges expired trash only after destructive confirmation, and disables another purge when none remain", async () => {
  const gateway = fixture([job("trash", { pending: 4 })]);
  render(<Harness gateway={gateway} />);
  await userEvent.click(await screen.findByRole("button", { name: "만료분 비우기" }));
  expect(gateway.runAutoJob).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: /4개를 영구 삭제/ })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(gateway.runAutoJob).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "만료분 비우기" }));
  await userEvent.click(screen.getByRole("button", { name: "영구 삭제" }));
  await waitFor(() => expect(gateway.runAutoJob).toHaveBeenCalledExactlyOnceWith("trash"));
  await waitFor(() => expect(screen.getByRole("button", { name: "만료분 비우기" })).toBeDisabled());
  expect(screen.getByText("14일 지난 것 없음")).toBeVisible();
});

it("sends a forced catalog run through run_auto_job even in lightweight mode and shows the returned count", async () => {
  const gateway = fixture([job("catalog", { enabled: false, state: "off", intervalSeconds: 3600 })]);
  gateway.runAutoJob = libraryGateway.runAutoJob;
  const result = job("catalog", { enabled: false, state: "off", lastOk: true, lastRunAt: new Date().toISOString(), lastCount: 3, intervalSeconds: 3600 });
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "run_auto_job") { gateway.autoJobsStatus = vi.fn(async () => [result]); return result; }
    throw new Error(`Unexpected command: ${command}`);
  });
  render(<Harness gateway={gateway} />);
  await userEvent.click(await screen.findByRole("button", { name: "지금 갱신" }));
  expect(invoke).toHaveBeenCalledExactlyOnceWith("run_auto_job", { id: "catalog" });
  expect(await screen.findByText(/새 작품 3개/)).toBeVisible();
});

it("keeps the previous status when a refresh fails", async () => {
  const gateway = fixture([job("catalog", { lastCount: 32 })]);
  const hook = renderHook(() => useAutoJobs(gateway, true));
  await waitFor(() => expect(hook.result.current.jobs?.[0]?.lastCount).toBe(32));
  vi.mocked(gateway.autoJobsStatus!).mockRejectedValue(new Error("일시적인 연결 실패"));
  act(() => hook.result.current.refresh());
  await waitFor(() => expect(hook.result.current.error).not.toBeNull());
  expect(hook.result.current.jobs?.[0]?.lastCount).toBe(32);
});

it("saves cloud replication without changing capture settings", async () => {
  const gateway = fixture([job("cloudBackfill", { enabled: true })]);
  gateway.getCloudCaptureSettings = vi.fn(async () => ({ enabled: true, captureEnabled: false, apiBaseUrl: "https://cloud.test", tokenConfigured: true }));
  gateway.setCloudCaptureSettings = vi.fn(async () => ({ enabled: false, captureEnabled: false, apiBaseUrl: "https://cloud.test", tokenConfigured: true }));
  render(<Harness gateway={gateway} />);
  await userEvent.click(await screen.findByRole("switch", { name: "클라우드로 복제" }));
  expect(gateway.setCloudCaptureSettings).toHaveBeenCalledExactlyOnceWith(false, "https://cloud.test", false);
});

it("polls running work quickly only in the visible section and stops on leaving Settings", async () => {
  vi.useFakeTimers();
  const gateway = fixture([job("launchbox", { state: "running", canStop: true })]);
  const hook = renderHook(({ visible }) => useAutoJobs(gateway, visible), { initialProps: { visible: true } });
  await act(async () => {});
  vi.mocked(gateway.autoJobsStatus!).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(gateway.autoJobsStatus).toHaveBeenCalledTimes(1);
  hook.rerender({ visible: false });
  await act(async () => {});
  vi.mocked(gateway.autoJobsStatus!).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(gateway.autoJobsStatus).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(13000); });
  expect(gateway.autoJobsStatus).toHaveBeenCalledTimes(1);
  hook.unmount();
  vi.mocked(gateway.autoJobsStatus!).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(gateway.autoJobsStatus).not.toHaveBeenCalled();
});

it("moves a late row into the top attention group and shows overdue status", async () => {
  const gateway = fixture([
    job("catalog", { intervalSeconds: 3600 }),
    job("autoTags", { overdueSince: new Date(Date.now() - 27 * 3600_000).toISOString() }),
    job("releaseWatch", { state: "failed", lastOk: false }),
  ]);
  render(<Harness gateway={gateway} />);
  const attention = await screen.findByRole("region", { name: "확인 필요" });
  expect(within(attention).getByText("자동 태그 가져오기")).toBeVisible();
  expect(within(attention).getByText("늦음")).toBeVisible();
  expect(within(attention).getByText("찜·신간 발매 확인")).toBeVisible();
  expect(within(screen.getByRole("region", { name: "분석" })).queryByText("자동 태그 가져오기")).toBeNull();
  const normal = screen.getByRole("region", { name: "새 정보" });
  expect(attention.compareDocumentPosition(normal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  render(<AutoJobsSummary jobs={await gateway.autoJobsStatus!()} />);
  expect(screen.getByText("늦음 1")).toBeVisible();
});
