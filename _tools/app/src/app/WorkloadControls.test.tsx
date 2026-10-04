import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined),
  performance: { selected: "laptop", active: "laptop", ready: true, error: null as string | null },
  setPerformance: vi.fn().mockResolvedValue(undefined),
  profile: { lightweight: true, restricted: true, hidden: false, autoEnterMinutes: 10 as number | null, closeToTray: true, trayAvailable: true, ready: true, error: null },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./workloadProfile", () => ({ nativeWorkload: () => true, useWorkloadProfile: () => mocks.profile, updateWorkloadSettings: mocks.update }));
vi.mock("./performanceProfile", () => ({ usePerformanceProfile: () => mocks.performance, updatePerformanceProfile: mocks.setPerformance }));
import { LightweightModeToggle, WorkloadControls } from "./WorkloadControls";
afterEach(() => { cleanup(); mocks.profile.ready = true; mocks.profile.lightweight = true; vi.clearAllMocks(); });
it("toggles lightweight mode without exposing scan cancellation", () => {
  render(<LightweightModeToggle />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(screen.getByRole("switch", { name: "절약 모드" })).toBeChecked();
  fireEvent.click(screen.getByRole("switch", { name: "절약 모드" }));
  expect(mocks.update).toHaveBeenCalledWith({ lightweight: false });
  expect(screen.queryByRole("button", { name: "검사 중단 요청" })).not.toBeInTheDocument();
});
it("saves a bounded auto-entry delay and close preference", () => {
  render(<WorkloadControls />);
  const minutes = screen.getByRole("spinbutton", { name: "자동 전환 대기 (분)" });
  fireEvent.change(minutes, { target: { value: "0" } });
  fireEvent.blur(minutes);
  expect(mocks.update).not.toHaveBeenCalledWith({ autoEnterMinutes: 0 });
  fireEvent.change(minutes, { target: { value: "25" } });
  fireEvent.blur(minutes);
  expect(mocks.update).toHaveBeenCalledWith({ autoEnterMinutes: 25 });
  fireEvent.click(screen.getByRole("switch", { name: "닫기 버튼으로 트레이에 숨기기" }));
  expect(mocks.update).toHaveBeenCalledWith({ closeToTray: false });
});

it("saves only this computer's performance and shows restart pending without changing saving mode", async () => {
  const view = render(<WorkloadControls />);
  const selector = screen.getByRole("combobox", { name: "이 컴퓨터의 성능" });
  expect(selector).toHaveValue("laptop");
  await act(async () => { fireEvent.change(selector, { target: { value: "main" } }); });
  expect(mocks.setPerformance).toHaveBeenCalledWith("main");
  expect(mocks.update).not.toHaveBeenCalled();
  mocks.performance.selected = "main";
  view.rerender(<WorkloadControls />);
  expect(screen.getByRole("status")).toHaveTextContent("재시작 후 적용 · 현재 노트북");
  expect(screen.getByRole("switch", { name: "절약 모드" })).toBeChecked();
  expect(screen.getByRole("spinbutton")).toHaveValue(10);
  mocks.performance.selected = "laptop";
  view.rerender(<WorkloadControls />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("keeps the performance selector unavailable until native settings load", () => {
  mocks.performance.ready = false;
  render(<WorkloadControls />);
  expect(screen.getByRole("combobox", { name: "이 컴퓨터의 성능" })).toBeDisabled();
  mocks.performance.ready = true;
});

it("shows recovery wording only after the workload profile is ready", () => {
  mocks.profile.ready = false;
  mocks.profile.lightweight = false;
  const view = render(<LightweightModeToggle />);
  expect(screen.getByText("확인 중…")).toBeInTheDocument();
  expect(screen.queryByText("절약 모드 해제 중")).not.toBeInTheDocument();
  expect(screen.queryByText("3분 안에 평소 속도로 돌아갑니다")).not.toBeInTheDocument();
  expect(screen.getByRole("switch")).toBeDisabled();
  mocks.profile.ready = true;
  view.rerender(<LightweightModeToggle />);
  expect(screen.getByText("절약 모드 해제 중")).toBeInTheDocument();
  expect(screen.getByText("3분 안에 평소 속도로 돌아갑니다")).toBeInTheDocument();
  mocks.profile.lightweight = true;
  view.rerender(<LightweightModeToggle />);
  expect(screen.getByText("절약 모드")).toBeInTheDocument();
  expect(screen.queryByText("3분 안에 평소 속도로 돌아갑니다")).not.toBeInTheDocument();
});
it("keeps the settings mode status neutral before readiness", () => {
  mocks.profile.ready = false;
  mocks.profile.lightweight = false;
  render(<WorkloadControls />);
  expect(screen.getByText("확인 중…")).toBeInTheDocument();
  expect(screen.queryByText("절약 모드 해제 중")).not.toBeInTheDocument();
});
