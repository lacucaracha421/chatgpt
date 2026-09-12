import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterAutomationStatus } from "./CharacterAutomationStatus";

afterEach(cleanup);

const quietState = {
  revision: 0,
  persistentError: null,
  historyRefreshActive: false,
  paused: false,
  dismissError: vi.fn(),
  pauseHistoryRefresh: vi.fn(),
  resumeHistoryRefresh: vi.fn(),
  setupRuntime: vi.fn().mockResolvedValue(undefined),
};

it("renders nothing when no active work is reported", () => {
  const { container } = render(<CharacterAutomationStatus state={{
    ...quietState,
    progress: { total: 4, completed: 1 },
    queuePending: 12,
    activeSeriesName: "젠레스",
  } as any} />);

  expect(container).toBeEmptyDOMElement();
});

it("shows the active character and request-wide remaining images rather than the current comparison count", () => {
  render(<CharacterAutomationStatus state={{ ...quietState, historyRefreshActive: true,
    activeWork: { active: true, seriesName: "젠레스", targetName: "레미엘", cause: "reconsideration", freshRemaining: 3 },
    historyRefreshes: [{ targetId: "remiel", targetName: "레미엘", seriesName: "젠레스", state: "running", total: 700, processed: 125, remaining: 575, failed: 2 }],
  }} />);
  expect(screen.getByText("현재 작업 · 젠레스 / 레미엘 비교 중")).toBeVisible();
  expect(screen.getByText("새 이미지 분석 · 3개 남음")).toBeVisible();
  expect(screen.getByText("125 / 700개 처리 · 575개 남음 · 실패 2개")).toBeVisible();
});

it("does not invent a total for legacy requests still discovering candidates", () => {
  render(<CharacterAutomationStatus state={{ ...quietState, historyRefreshActive: true,
    historyRefreshes: [{ targetId: "a", targetName: "레미엘", seriesName: "젠레스", state: "running", total: null, processed: 4, remaining: 28, failed: 0 }],
  }} />);
  expect(screen.getByText("대상 확인 중 · 4개 처리 · 확인된 대기 28개")).toBeVisible();
  expect(screen.queryByText(/\/ 32개/)).not.toBeInTheDocument();
});

it("retains failed refresh details after the active flag clears", () => {
  render(<CharacterAutomationStatus state={{ ...quietState,
    historyRefreshes: [{ targetId: "a", targetName: "레미엘", seriesName: "젠레스", state: "failed", total: 700, processed: 700, remaining: 0, failed: 2 }],
  }} />);
  expect(screen.getByText(/700 \/ 700개 처리 · 0개 남음 · 실패 2개/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "일시 정지" })).not.toBeInTheDocument();
});

it("shows persistent runtime failure with recovery and dismiss actions", async () => {
  const user = userEvent.setup();
  const dismissError = vi.fn();
  const setupRuntime = vi.fn().mockResolvedValue(undefined);
  render(<CharacterAutomationStatus state={{
    ...quietState,
    persistentError: "런타임을 시작하지 못했습니다.",
    dismissError,
    setupRuntime,
  } as any} />);

  expect(screen.getByRole("alert")).toHaveTextContent("캐릭터 분석 오류");
  expect(screen.getByRole("alert")).toHaveTextContent("런타임을 시작하지 못했습니다.");
  await user.click(screen.getByRole("button", { name: "분석 환경 설정" }));
  expect(setupRuntime).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "닫기" }));
  expect(dismissError).toHaveBeenCalledTimes(1);
});

it("shows pause and resume only for a user requested history refresh", async () => {
  const user = userEvent.setup();
  const pauseHistoryRefresh = vi.fn();
  const { rerender } = render(<CharacterAutomationStatus state={{
    ...quietState,
    historyRefreshActive: true,
    pauseHistoryRefresh,
  } as any} />);

  expect(screen.getByText("과거 미분류 이미지 갱신 중")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "일시 정지" }));
  expect(pauseHistoryRefresh).toHaveBeenCalledTimes(1);

  const resumeHistoryRefresh = vi.fn();
  rerender(<CharacterAutomationStatus state={{
    ...quietState,
    historyRefreshActive: true,
    paused: true,
    resumeHistoryRefresh,
  } as any} />);
  expect(screen.getByText("과거 미분류 이미지 갱신 일시 정지")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "재개" }));
  expect(resumeHistoryRefresh).toHaveBeenCalledTimes(1);
});
