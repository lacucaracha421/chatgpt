import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import { libraryGateway } from "../library/client";
import { CloudBackfillSettings } from "./CloudBackfillSettings";

const inactive = {
  controlState: "idle" as const,
  totalAssets: 10,
  queued: 0,
  preparing: 0,
  uploading: 0,
  committing: 0,
  completed: 0,
  failed: 0,
  activeWorkers: 0,
  lastError: null,
};

function renderSection(overrides: Record<string, unknown> = {}) {
  const gateway = {
    ...libraryGateway,
    cloudBackfillPreflight: vi.fn().mockResolvedValue({
      totalAssets: 10,
      readyAssets: 7,
      alreadyReplicated: 2,
      missingOriginals: 1,
      thumbnailWorkRequired: 3,
      problemAssets: 1,
      assets: [],
    }),
    cloudBackfillProgress: vi.fn().mockResolvedValue(inactive),
    cloudBackfillSeed: vi.fn().mockResolvedValue({ seeded: 7, skippedReplicated: 2, skippedProblem: 1 }),
    cloudBackfillRunCycle: vi.fn(),
    cloudBackfillSetControlState: vi.fn().mockResolvedValue("running"),
    cloudBackfillReconcile: vi.fn().mockResolvedValue({ requeued: 0 }),
    cloudBackfillRetryFailed: vi.fn().mockResolvedValue({ retried: 0 }),
    ...overrides,
  };
  render(<LibraryProvider gateway={gateway as typeof libraryGateway}><CloudBackfillSettings /></LibraryProvider>);
  return gateway;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it("renders the compact read-only preflight summary", async () => {
  renderSection();
  await userEvent.click(screen.getByRole("button", { name: "사전 점검" }));
  const summary = await screen.findByLabelText("모바일 동기화 사전 점검 결과");
  expect(within(summary).getByText("전체 10개")).toBeInTheDocument();
  expect(within(summary).getByText("준비됨 7개")).toBeInTheDocument();
  expect(within(summary).getByText("원본 문제 1개")).toBeInTheDocument();
  expect(within(summary).getByText("썸네일 작업 3개")).toBeInTheDocument();
  expect(within(summary).getByText("문제 항목 1개")).toBeInTheDocument();
});

it("does not seed or run work while initially inactive", async () => {
  const gateway = renderSection();
  await screen.findByText("시작 전");
  expect(gateway.cloudBackfillSeed).not.toHaveBeenCalled();
  expect(gateway.cloudBackfillRunCycle).not.toHaveBeenCalled();
});

it("starts only after explicit confirmation and reports seed counts", async () => {
  const gateway = renderSection();
  await userEvent.click(await screen.findByRole("button", { name: "전체 라이브러리 업로드 준비" }));
  await userEvent.click(screen.getByRole("button", { name: "업로드 시작 확인" }));
  await waitFor(() => expect(gateway.cloudBackfillSetControlState).toHaveBeenCalledWith("running"));
  expect(gateway.cloudBackfillPreflight).toHaveBeenCalledTimes(1);
  expect(gateway.cloudBackfillSeed).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("새로 대기열에 추가 7개 · 이미 복제됨 2개")).toBeInTheDocument();
});

it("renders persistent progress counts and percentage", async () => {
  renderSection({ cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, totalAssets: 20, queued: 5, completed: 15 }) });
  expect(await screen.findByText("15 / 20개 (75%)")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "75");
});

it("renders active transfer stages and worker count", async () => {
  renderSection({ cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, controlState: "running", queued: 4, preparing: 1, uploading: 2, committing: 1, activeWorkers: 4 }) });
  expect(await screen.findByText("업로드 중")).toBeInTheDocument();
  expect(screen.getByText(/준비 1 · 업로드 2 · 커밋 1 · 작업자 4/)).toBeInTheDocument();
});

it("pauses by changing control state without changing queue rows", async () => {
  const setState = vi.fn().mockResolvedValue("paused");
  const gateway = renderSection({ cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, controlState: "running", queued: 2 }), cloudBackfillSetControlState: setState });
  await userEvent.click(await screen.findByRole("button", { name: "일시정지" }));
  expect(setState).toHaveBeenCalledWith("paused");
  expect(gateway.cloudBackfillRetryFailed).not.toHaveBeenCalled();
});

it("resumes by reconciling before setting running and never reseeds", async () => {
  const calls: string[] = [];
  const gateway = renderSection({
    cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, controlState: "paused", queued: 2 }),
    cloudBackfillReconcile: vi.fn().mockImplementation(async () => { calls.push("reconcile"); return { requeued: 1 }; }),
    cloudBackfillSetControlState: vi.fn().mockImplementation(async () => { calls.push("running"); return "running"; }),
  });
  await userEvent.click(await screen.findByRole("button", { name: "계속" }));
  await waitFor(() => expect(calls).toEqual(["reconcile", "running"]));
  expect(gateway.cloudBackfillSeed).not.toHaveBeenCalled();
});

it("retries failed items without reseeding and restarts idle orchestration", async () => {
  const retry = vi.fn().mockResolvedValue({ retried: 3 });
  const gateway = renderSection({ cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, failed: 3 }), cloudBackfillRetryFailed: retry });
  await userEvent.click(await screen.findByRole("button", { name: "실패 항목 다시 시도" }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(gateway.cloudBackfillSeed).not.toHaveBeenCalled();
  expect(gateway.cloudBackfillSetControlState).toHaveBeenCalledWith("running");
});

it("keeps failed count and recent diagnostic visible", async () => {
  renderSection({ cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, completed: 8, failed: 2, lastError: "CloudThumbnailUnavailable: poster missing" }) });
  expect(await screen.findByText("확인 필요 2개")).toBeInTheDocument();
  expect(screen.getByText(/CloudThumbnailUnavailable: poster missing/)).toBeInTheDocument();
});

it("distinguishes clean completion from completion with problems", async () => {
  const { rerender } = render(<LibraryProvider gateway={{ ...libraryGateway, cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, totalAssets: 8, completed: 8 }) } as typeof libraryGateway}><CloudBackfillSettings /></LibraryProvider>);
  expect(await screen.findByText("복제 완료 — 8개 완료")).toBeInTheDocument();
  rerender(<LibraryProvider gateway={{ ...libraryGateway, cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, totalAssets: 10, completed: 8, failed: 2 }) } as typeof libraryGateway}><CloudBackfillSettings /></LibraryProvider>);
  expect(await screen.findByText("복제 완료 — 8개 완료, 2개 확인 필요")).toBeInTheDocument();
});

it("offers an explicit non-destructive interrupted-work recovery action", async () => {
  const reconcile = vi.fn().mockResolvedValue({ requeued: 2 });
  renderSection({ cloudBackfillReconcile: reconcile });
  await userEvent.click(await screen.findByRole("button", { name: "중단된 작업 복구" }));
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("중단된 작업 2개를 대기열로 복구했습니다.")).toBeInTheDocument();
});

it("refreshes persistent counts immediately after an operator action", async () => {
  const progress = vi.fn()
    .mockResolvedValueOnce({ ...inactive, totalAssets: 5, queued: 5 })
    .mockResolvedValue({ ...inactive, totalAssets: 5, completed: 5 });
  renderSection({ cloudBackfillProgress: progress, cloudBackfillReconcile: vi.fn().mockResolvedValue({ requeued: 0 }) });
  expect(await screen.findByText("0 / 5개 (0%)")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "중단된 작업 복구" }));
  expect(await screen.findByText("5 / 5개 (100%)")).toBeInTheDocument();
});

it("never creates a worker cycle when the Settings section is reopened", async () => {
  const first = renderSection({ cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, controlState: "running", queued: 2 }) });
  await screen.findByText("업로드 중");
  cleanup();
  const second = renderSection({ cloudBackfillProgress: vi.fn().mockResolvedValue({ ...inactive, controlState: "running", queued: 2 }) });
  await screen.findByText("업로드 중");
  expect(first.cloudBackfillRunCycle).not.toHaveBeenCalled();
  expect(second.cloudBackfillRunCycle).not.toHaveBeenCalled();
});
