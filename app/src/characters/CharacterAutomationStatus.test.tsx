import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterAutomationStatus } from "./CharacterAutomationStatus";

afterEach(cleanup);

it("keeps an analysis error visible while queued work is waiting", () => {
  render(<CharacterAutomationStatus state={{
    progress: null,
    message: "캐릭터 분석 실패 · 추가 참조를 확인해 주세요.",
    paused: false,
    queuePending: 3,
    queueAutomatic: 3,
    queueLegacy: 0,
    queueManual: 0,
    queueReconsideration: 0,
    activeCause: null,
    activeSeriesName: null,
    activeTargetName: null,
    activeTargetIndex: 0,
    activeReconsideration: false,
    pause: vi.fn(), resume: vi.fn(), dismiss: vi.fn(),
  } as any} />);

  expect(screen.getByText(/캐릭터 분석 준비/)).toBeVisible();
  expect(screen.getByText("캐릭터 분석 실패 · 추가 참조를 확인해 주세요.")).toBeVisible();
});
