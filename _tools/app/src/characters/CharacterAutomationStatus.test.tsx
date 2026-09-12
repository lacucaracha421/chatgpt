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

it("renders nothing for normal background progress", () => {
  const { container } = render(<CharacterAutomationStatus state={{
    ...quietState,
    progress: { total: 4, completed: 1 },
    queuePending: 12,
    activeSeriesName: "젠레스",
  } as any} />);

  expect(container).toBeEmptyDOMElement();
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
