import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined),
  profile: { lightweight: true, restricted: true, hidden: false, autoEnterMinutes: 10 as number | null, closeToTray: true, trayAvailable: true, ready: true, error: null },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./workloadProfile", () => ({ nativeWorkload: () => true, useWorkloadProfile: () => mocks.profile, updateWorkloadSettings: mocks.update }));
import { LightweightModeToggle, WorkloadControls } from "./WorkloadControls";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("toggles lightweight mode without exposing scan cancellation", () => {
  render(<LightweightModeToggle />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(screen.getByRole("switch", { name: "가벼운 모드" })).toBeChecked();
  fireEvent.click(screen.getByRole("switch", { name: "가벼운 모드" }));
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
