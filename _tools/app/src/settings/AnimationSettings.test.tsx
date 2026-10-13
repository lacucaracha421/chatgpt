import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AnimationSettings } from "./AnimationSettings";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("saves both options and keeps the restart note across visits", async () => {
  let selected = "system";
  bridge.invoke.mockImplementation(async (_command, args) => {
    if (args) selected = args.preference;
    return { selected, active: "system" };
  });
  const view = render(<AnimationSettings />);
  const select = screen.getByRole("combobox", { name: "애니메이션" });
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveValue("system");
  expect(screen.getByRole("option", { name: "Windows 설정 따르기" })).toBeInTheDocument();
  expect(select).toHaveAccessibleDescription("Windows에서 애니메이션 효과를 꺼 두어도 Lakomics에서는 움직임을 보여 줍니다. 바꾸면 앱을 다시 시작해야 적용됩니다.");
  expect(screen.queryByText("다시 시작하면 적용됩니다")).not.toBeInTheDocument();
  await userEvent.selectOptions(select, "always");
  expect(bridge.invoke).toHaveBeenLastCalledWith("motion_preference", { preference: "always" });
  expect(await screen.findByText("다시 시작하면 적용됩니다")).toBeVisible();
  expect(select).toHaveValue("always");
  view.unmount();
  render(<AnimationSettings />);
  expect(await screen.findByText("다시 시작하면 적용됩니다")).toBeVisible();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "애니메이션" }), "system");
  await waitFor(() => expect(screen.queryByText("다시 시작하면 적용됩니다")).not.toBeInTheDocument());
  expect(bridge.invoke).toHaveBeenLastCalledWith("motion_preference", { preference: "system" });
});

it("shows the applied setting after restart without a pending note", async () => {
  bridge.invoke.mockResolvedValue({ selected: "always", active: "always" });
  render(<AnimationSettings />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "애니메이션" })).toHaveValue("always"));
  expect(screen.queryByText("다시 시작하면 적용됩니다")).not.toBeInTheDocument();
});

it("retains the saved selection and reports a failed save", async () => {
  bridge.invoke.mockResolvedValueOnce({ selected: "system", active: "system" }).mockRejectedValueOnce(new Error("disk"));
  render(<AnimationSettings />);
  const select = screen.getByRole("combobox", { name: "애니메이션" });
  await waitFor(() => expect(select).toBeEnabled());
  await userEvent.selectOptions(select, "always");
  expect(await screen.findByRole("alert")).toHaveTextContent("애니메이션 설정을 저장하지 못했습니다.");
  expect(select).toHaveValue("system");
  expect(select).toBeEnabled();
  expect(screen.queryByText("다시 시작하면 적용됩니다")).not.toBeInTheDocument();
});

it("disables saving when the stored setting cannot be read", async () => {
  bridge.invoke.mockRejectedValue(new Error("disk"));
  render(<AnimationSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("애니메이션 설정을 불러오지 못했습니다.");
  expect(screen.getByRole("combobox", { name: "애니메이션" })).toBeDisabled();
});
