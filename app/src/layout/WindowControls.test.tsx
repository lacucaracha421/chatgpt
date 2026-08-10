import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";

const minimize = vi.fn();
const toggleMaximize = vi.fn();
const close = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close }),
}));
afterEach(() => { cleanup(); minimize.mockClear(); toggleMaximize.mockClear(); close.mockClear(); });

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
