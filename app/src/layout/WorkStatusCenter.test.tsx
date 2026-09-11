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
  progress: null,
  message: null,
  paused: false,
  queuePending: 0,
  queueAutomatic: 0,
  queueLegacy: 0,
  queueManual: 0,
  queueReconsideration: 0,
  activeCause: null,
  activeSeriesName: null,
  activeTargetName: null,
  activeTargetIndex: 0,
  activeReconsideration: false,
  pause: vi.fn(), resume: vi.fn(), dismiss: vi.fn(),
} as any;

it("keeps an always available work entry and reveals an idle detail panel", async () => {
  render(<WorkStatusCenter characterAutomation={idleCharacterAutomation} progress={null}
    similarityIndex={{ running: false, remaining: 0, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: "작업 센터" });
  expect(trigger).toHaveAttribute("data-state", "idle");
  await userEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "작업 센터" })).toHaveTextContent("진행 중인 작업이 없습니다.");
});

it("summarizes active work on the rail and keeps its detailed controls in the panel", async () => {
  let finish!: () => void;
  act(() => {
    void startPublication("catalog", () => new Promise<number>((resolve) => { finish = () => resolve(1); }), String);
  });
  render(<WorkStatusCenter characterAutomation={{ ...idleCharacterAutomation, paused: true, queuePending: 2, queueAutomatic: 2 }}
    progress={{ current: 1, total: 4 }} similarityIndex={{ running: true, remaining: 9, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: /작업 센터 · 4개 진행 중/ });
  expect(trigger).toHaveAttribute("data-state", "active");
  expect(screen.queryByText("파일 가져오기 1 / 4")).not.toBeInTheDocument();

  await userEvent.click(trigger);
  const panel = screen.getByRole("dialog", { name: "작업 센터" });
  expect(panel).toHaveTextContent("파일 가져오기 1 / 4");
  expect(panel).toHaveTextContent("유사 이미지 준비 중 · 9개 남음");
  expect(panel).toHaveTextContent("캐릭터 분석 일시 정지");

  await act(async () => { finish(); });
});
