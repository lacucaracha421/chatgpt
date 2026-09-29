import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const workload = vi.hoisted(() => ({
  profile: { restricted: false, lightweight: false },
  update: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../app/workloadProfile", () => ({
  useWorkloadProfile: () => workload.profile,
  updateWorkloadSettings: workload.update,
}));

import { LightweightModeIndicator, WindowControls } from "./WindowControls";

const minimize = vi.fn();
const toggleMaximize = vi.fn();
const close = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close }),
}));
afterEach(() => { cleanup(); minimize.mockClear(); toggleMaximize.mockClear(); close.mockClear(); workload.profile.restricted = false; workload.profile.lightweight = false; workload.update.mockClear(); });

it("hides the lightweight-mode indicator when the profile is unrestricted", () => {
  render(<LightweightModeIndicator />);
  expect(screen.queryByRole("button", { name: "절약 모드 끄기" })).not.toBeInTheDocument();
});

it("shows the lightweight-mode indicator when the profile is restricted", () => {
  workload.profile.restricted = true; workload.profile.lightweight = true;
  render(<LightweightModeIndicator />);
  const indicator = screen.getByRole("button", { name: "절약 모드 끄기" });
  expect(indicator).toHaveTextContent("절약 모드");
  expect(indicator.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

it("turns lightweight mode off from the titlebar indicator", async () => {
  workload.profile.restricted = true; workload.profile.lightweight = true;
  const user = userEvent.setup();
  const { rerender } = render(<LightweightModeIndicator />);
  await user.click(screen.getByRole("button", { name: "절약 모드 끄기" }));
  expect(workload.update).toHaveBeenCalledWith({ lightweight: false });

  // Recovery window: the button becomes a quiet status so the click visibly took effect.
  workload.profile.lightweight = false;
  rerender(<LightweightModeIndicator />);
  expect(screen.queryByRole("button", { name: "절약 모드 끄기" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("절약 모드 해제 중");

  workload.profile.restricted = false;
  rerender(<LightweightModeIndicator />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("renders minimize, maximize, and close buttons", () => {
  render(<WindowControls />);
  expect(screen.getByRole("button", { name: "창 최소화" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 최대화" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

it("calls the window API on each button click", async () => {
  const user = userEvent.setup();
  render(<WindowControls />);
  await user.click(screen.getByRole("button", { name: "창 최소화" }));
  await user.click(screen.getByRole("button", { name: "창 최대화" }));
  await user.click(screen.getByRole("button", { name: "창 닫기" }));
  expect(minimize).toHaveBeenCalledOnce();
  expect(toggleMaximize).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
