import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudBackfillProgress } from "../library/types";

const workload = vi.hoisted(() => ({
  native: false,
  update: vi.fn().mockResolvedValue(undefined),
  profile: { lightweight: false, restricted: false, hidden: false, autoEnterMinutes: null, closeToTray: true, trayAvailable: true, ready: true, error: null },
}));
vi.mock("../app/workloadProfile", () => ({
  nativeWorkload: () => workload.native,
  useWorkloadProfile: () => workload.profile,
  updateWorkloadSettings: workload.update,
}));

import { dismissPublication, startPublication } from "../library/publicationJobs";
import { resetVaultExportJob, startVaultExport } from "../external-vault/vaultExportJob";
import { resetVaultImportJob, startVaultImport } from "../external-vault/vaultImportJob";
import { StatusCenter, type StatusWork } from "./StatusCenter";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

afterEach(() => {
  cleanup();
  dismissPublication("catalog");
  dismissPublication("collections");
  resetVaultImportJob();
  resetVaultExportJob();
  workload.native = false;
  vi.clearAllMocks();
});

const idleCharacterAutomation = {
  revision: 0,
  persistentError: null,
  historyRefreshActive: false,
  paused: false,
  dismissError: vi.fn(),
  pauseHistoryRefresh: vi.fn(),
  resumeHistoryRefresh: vi.fn(),
  setupRuntime: vi.fn(),
} as any;

const syncedProgress = { controlState: "idle", replicationEnabled: true, totalAssets: 10, queued: 0, preparing: 0, uploading: 0, committing: 0, completed: 10, failed: 0, activeWorkers: 0, lastError: null, activity: [] } as CloudBackfillProgress;

it("stays quiet when idle, closes on Escape and returns focus to the indicator", async () => {
  const user = userEvent.setup();
  render(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null} onNavigate={vi.fn()}
    similarityIndex={{ running: false, remaining: 0, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: "상태" });
  expect(trigger).toHaveAttribute("data-state-tone", "idle");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.click(trigger);
  const panel = screen.getByRole("dialog", { name: "상태" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(panel).toHaveTextContent("진행 중인 작업이 없습니다.");
  expect(within(panel).queryByRole("region", { name: "확인할 것" })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("lists only non-empty review queues with real counts and navigates to them", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const onOpenChange = vi.fn();
  const { rerender } = render(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null}
    reviewCount={0} unsortedCount={0} onNavigate={onNavigate} onOpenChange={onOpenChange} />);
  await user.click(screen.getByRole("button", { name: "상태" }));
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("region", { name: "확인할 것" })).not.toBeInTheDocument();

  rerender(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null}
    reviewCount={12} unsortedCount={248} onNavigate={onNavigate} onOpenChange={onOpenChange} />);
  const queues = screen.getByRole("region", { name: "확인할 것" });
  expect(within(queues).getByRole("button", { name: /유사 이미지 검토/ })).toHaveTextContent("12");
  await user.click(within(queues).getByRole("button", { name: /미분류/ }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "unsorted" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "상태 · 확인 12개 대기" })).toHaveAttribute("data-state-tone", "queue");

  rerender(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null}
    reviewCount={3} unsortedCount={0} onNavigate={onNavigate} onOpenChange={onOpenChange} />);
  await user.click(screen.getByRole("button", { name: /^상태/ }));
  const onlyReview = screen.getByRole("region", { name: "확인할 것" });
  expect(within(onlyReview).queryByRole("button", { name: /미분류/ })).not.toBeInTheDocument();
  await user.click(within(onlyReview).getByRole("button", { name: /유사 이미지 검토/ }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "similarity_review" });
});

it("shows sync problems as the indicator's problem state and opens cloud settings", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const { rerender } = render(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null}
    cloud={{ problemCount: 0, progress: syncedProgress }} onNavigate={onNavigate} />);
  await user.click(screen.getByRole("button", { name: "상태" }));
  expect(screen.getByRole("region", { name: "동기화" })).toHaveTextContent("동기화됨");
  await user.keyboard("{Escape}");

  rerender(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null}
    cloud={{ problemCount: 3, progress: { ...syncedProgress, failed: 3 } }} onNavigate={onNavigate} />);
  const trigger = screen.getByRole("button", { name: "상태 · 문제 3개" });
  expect(trigger).toHaveAttribute("data-state-tone", "attention");
  await user.click(trigger);
  expect(screen.getByRole("alert")).toHaveTextContent("동기화 문제 3개");
  await user.click(screen.getByRole("button", { name: "동기화 설정 열기" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "settings", section: "cloud" });
});

it("offers the instant lightweight-mode toggle only in the native app", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null} onNavigate={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "상태" }));
  expect(screen.queryByRole("checkbox", { name: "가벼운 모드" })).not.toBeInTheDocument();
  unmount();

  workload.native = true;
  render(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null} onNavigate={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "상태" }));
  const pc = screen.getByRole("region", { name: "이 PC" });
  const toggle = within(pc).getByRole("checkbox", { name: "가벼운 모드" });
  expect(toggle).not.toBeChecked();
  await user.click(toggle);
  expect(workload.update).toHaveBeenCalledWith({ lightweight: true });
});

it("summarizes an explicit character history refresh alongside other active work", async () => {
  let finish!: () => void;
  act(() => {
    void startPublication("catalog", () => new Promise<number>((resolve) => { finish = () => resolve(1); }), String);
  });
  render(<StatusCenter characterAutomation={{ ...idleCharacterAutomation, historyRefreshActive: true, paused: true }}
    progress={{ current: 1, total: 4 }} similarityIndex={{ running: true, remaining: 9, failed: 0 }} onNavigate={vi.fn()} />);

  const trigger = screen.getByRole("button", { name: "상태 · 작업 4개 진행 중" });
  expect(trigger).toHaveTextContent("작업 4");
  expect(screen.queryByText("파일 가져오기 1 / 4")).not.toBeInTheDocument();

  await userEvent.click(trigger);
  const panel = screen.getByRole("dialog", { name: "상태" });
  expect(panel).toHaveTextContent("파일 가져오기 1 / 4");
  expect(panel).toHaveTextContent("유사 이미지 준비 중 · 9개 남음");
  expect(panel).toHaveTextContent("과거 미분류 이미지 갱신 일시 정지");
  expect(within(panel).getByRole("button", { name: "재개" })).toBeVisible();

  await act(async () => { finish(); });
});

it("shows fresh character work and a persistent character failure with its recovery action", async () => {
  const { rerender } = render(<StatusCenter characterAutomation={{ ...idleCharacterAutomation,
    activeWork: { active: true, seriesName: "젠레스", targetName: "레미엘", cause: "ingestion", freshRemaining: 12 },
  }} progress={null} onNavigate={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "상태 · 작업 1개 진행 중" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("현재 작업 · 젠레스 / 레미엘 비교 중");
  expect(screen.getByRole("dialog")).toHaveTextContent("새 이미지 분석 · 12개 남음");

  rerender(<StatusCenter characterAutomation={{ ...idleCharacterAutomation, persistentError: "런타임을 시작하지 못했습니다." }}
    progress={null} onNavigate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "상태 · 문제 1개" })).toHaveAttribute("data-state-tone", "attention");
  expect(screen.getByRole("alert")).toHaveTextContent("캐릭터 분석 오류");
  expect(screen.getByRole("button", { name: "분석 환경 설정" })).toBeVisible();
});

it("carries the former work tray: import progress once, then results with their actions", async () => {
  const user = userEvent.setup();
  const retryWork = vi.fn();
  const openExisting = vi.fn();
  const running: StatusWork = { kind: "ingestion", id: "import", total: 3, completed: 1, added: 1, exactDuplicates: [], reviewPending: [], failures: [], status: "running" };
  const { rerender } = render(<StatusCenter characterAutomation={idleCharacterAutomation} progress={{ current: 1, total: 3 }}
    works={[running]} retryWork={retryWork} openExisting={openExisting} onNavigate={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "상태 · 작업 1개 진행 중" }));
  expect(screen.getByRole("group", { name: "가져오기 작업" })).toHaveTextContent("가져오는 중 1 / 3");
  expect(screen.queryByText("파일 가져오기 1 / 3")).not.toBeInTheDocument();

  rerender(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null} works={[{ ...running, completed: 3, status: "completed",
    exactDuplicates: [{ fileName: "b.png", existingAssetId: "asset-b" }], failures: [{ fileName: "c.png", message: "읽을 수 없음" }] }]}
    retryWork={retryWork} openExisting={openExisting} onNavigate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "상태 · 문제 1개" })).toBeInTheDocument();
  const tray = screen.getByRole("group", { name: "가져오기 작업" });
  expect(tray).toHaveTextContent("추가 1 · 중복 1 · 검토 대기 0 · 실패 1");
  await user.click(within(tray).getByRole("button", { name: "실패 파일 다시 시도" }));
  expect(retryWork).toHaveBeenCalledWith("import");
  await user.click(within(tray).getByRole("button", { name: "b.png 기존 자산 열기" }));
  expect(openExisting).toHaveBeenCalledWith("asset-b");
});

it("shows a running Private Vault import on the 더보기 rail item and in the status panel", async () => {
  const user = userEvent.setup();
  let progress!: (value: { processed: number; total: number; imported: number; skipped: number; failed: number }) => void;
  let finish!: (value: unknown) => void;
  const importIntoEncryptedVault = vi.fn((_folder: string, onProgress?: typeof progress) => {
    progress = onProgress!;
    return new Promise((resolve) => { finish = resolve; });
  });
  void startVaultImport({ importIntoEncryptedVault } as any, "/home/me/photos");
  render(<>
    <WorkspaceNavigation view={{ kind: "notes" }} collectionType="game" width={208} onWidthChange={vi.fn()} onNavigate={vi.fn()}
      assetNavigation={null} reviewCount={0} trashCount={0} privateVaultAvailable />
    <StatusCenter characterAutomation={idleCharacterAutomation} progress={null} onNavigate={vi.fn()} />
  </>);
  act(() => progress({ processed: 7, total: 20, imported: 7, skipped: 0, failed: 0 }));

  const rail = screen.getByRole("navigation", { name: "주요 영역" });
  expect(within(rail).getByRole("button", { name: "더보기" })).toHaveAccessibleDescription("가져오는 중 7 / 20");
  await user.click(screen.getByRole("button", { name: "상태 · 작업 1개 진행 중" }));
  expect(screen.getByRole("status", { name: "비밀 보관함 가져오기" })).toHaveTextContent("비밀 보관함 가져오기 · 가져오는 중 7 / 20");

  await act(async () => finish({ total: 20, imported: 19, skipped: 0, failed: 1, withoutThumbnail: 0, legacyTitles: 0, legacyThumbnails: 0 }));
  expect(within(rail).getByRole("button", { name: "더보기" })).not.toHaveAccessibleDescription();
  expect(screen.getByRole("status", { name: "비밀 보관함 가져오기" })).toHaveTextContent("완료 · 가져옴 19개 · 실패 1개");
  await user.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.queryByRole("status", { name: "비밀 보관함 가져오기" })).not.toBeInTheDocument();
});

it("shows a running Private Vault export in the status panel", async () => {
  const user = userEvent.setup();
  let progress!: (value: { processed: number; total: number; exported: number; failed: number }) => void;
  let finish!: (value: unknown) => void;
  const exportEncryptedVaultItems = vi.fn((_ids: string[], _folder: string, onProgress?: typeof progress) => {
    progress = onProgress!;
    return new Promise((resolve) => { finish = resolve; });
  });
  void startVaultExport({ exportEncryptedVaultItems } as any, ["a", "b"], "/home/me/out");
  render(<StatusCenter characterAutomation={idleCharacterAutomation} progress={null} onNavigate={vi.fn()} />);
  act(() => progress({ processed: 1, total: 2, exported: 1, failed: 0 }));

  await user.click(screen.getByRole("button", { name: "상태 · 작업 1개 진행 중" }));
  expect(screen.getByRole("status", { name: "비밀 보관함 내보내기" })).toHaveTextContent("내보내는 중 1 / 2");
  await act(async () => finish({ processed: 2, total: 2, exported: 1, failed: 1 }));
  expect(screen.getByRole("status", { name: "비밀 보관함 내보내기" })).toHaveTextContent("완료 · 내보냄 1개 · 실패 1개");
});
