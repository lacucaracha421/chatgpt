import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { dismissPublication, startPublication } from "../library/publicationJobs";
import { WorkStatusCenter } from "./WorkStatusCenter";

afterEach(() => {
  cleanup();
  dismissPublication("catalog");
  dismissPublication("collections");
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

it("keeps an always available work entry and reveals an idle detail panel", async () => {
  render(<WorkStatusCenter characterAutomation={idleCharacterAutomation} progress={null}
    similarityIndex={{ running: false, remaining: 0, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: "작업 센터" });
  expect(trigger).toHaveAttribute("data-state", "idle");
  await userEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "작업 센터" })).toHaveTextContent("진행 중인 작업이 없습니다.");
});

it("summarizes only an explicit character history refresh as active work", async () => {
  let finish!: () => void;
  act(() => {
    void startPublication("catalog", () => new Promise<number>((resolve) => { finish = () => resolve(1); }), String);
  });
  render(<WorkStatusCenter characterAutomation={{ ...idleCharacterAutomation, historyRefreshActive: true, paused: true }}
    progress={{ current: 1, total: 4 }} similarityIndex={{ running: true, remaining: 9, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: /작업 센터 · 4개 진행 중/ });
  expect(trigger).toHaveAttribute("data-state", "active");
  expect(screen.queryByText("파일 가져오기 1 / 4")).not.toBeInTheDocument();

  await userEvent.click(trigger);
  const panel = screen.getByRole("dialog", { name: "작업 센터" });
  expect(panel).toHaveTextContent("파일 가져오기 1 / 4");
  expect(panel).toHaveTextContent("유사 이미지 준비 중 · 9개 남음");
  expect(panel).toHaveTextContent("과거 미분류 이미지 갱신 일시 정지");

  await act(async () => { finish(); });
});

it("counts a persistent character failure as a problem with a recovery action", async () => {
  render(<WorkStatusCenter characterAutomation={{
    ...idleCharacterAutomation,
    persistentError: "런타임을 시작하지 못했습니다.",
  }} progress={null} similarityIndex={{ running: false, remaining: 0, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: "작업 센터 · 문제 1개" });
  expect(trigger).toHaveAttribute("data-state", "attention");
  await userEvent.click(trigger);
  expect(screen.getByRole("alert")).toHaveTextContent("캐릭터 분석 오류");
  expect(screen.getByRole("button", { name: "분석 환경 설정" })).toBeVisible();
});
