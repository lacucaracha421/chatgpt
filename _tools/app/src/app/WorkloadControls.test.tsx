import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined),
  profile: { lightweight: true, restricted: true, hidden: false, autoEnterMinutes: 10 as number | null, closeToTray: true, trayAvailable: true, ready: true, error: null },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./workloadProfile", () => ({ nativeWorkload: () => true, useWorkloadProfile: () => mocks.profile, updateWorkloadSettings: mocks.update }));
import { LightweightModeToggle, WorkloadControls } from "./WorkloadControls";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("offers cancellation from the panel toggle without stopping user scans merely on entering light mode", async () => {
  const cancel = vi.fn(); window.addEventListener("lakomics:cancel-user-scans", cancel);
  render(<LightweightModeToggle />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "가벼운 모드" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "검사 중단 요청" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(mocks.invoke).toHaveBeenCalledWith("workload_cancel_scans");
  expect(await screen.findByRole("status")).toHaveTextContent("진행 중인 검사가 안전한 지점에서 중단됩니다.");
  fireEvent.click(screen.getByRole("checkbox", { name: "가벼운 모드" }));
  expect(mocks.update).toHaveBeenCalledWith({ lightweight: false });
  window.removeEventListener("lakomics:cancel-user-scans", cancel);
});
it("saves a bounded auto-entry delay and close preference", () => {
  render(<WorkloadControls />);
  const minutes = screen.getByRole("spinbutton", { name: "대기 시간 (분)" });
  fireEvent.change(minutes, { target: { value: "0" } });
  expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
  fireEvent.change(minutes, { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(mocks.update).toHaveBeenCalledWith({ autoEnterMinutes: 25 });
  fireEvent.click(screen.getByRole("checkbox", { name: "닫기 버튼으로 트레이에 숨기기" }));
  expect(mocks.update).toHaveBeenCalledWith({ closeToTray: false });
});
