import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CharacterAugmentationSettings, type AugmentationSettings } from "./CharacterAugmentationSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const empty: AugmentationSettings = { enabled: false, modelName: null, modelReady: false, runtimeConfigured: true, managedByEnvironment: false };
const ready = { ...empty, modelName: "S36.onnx", modelReady: true };
beforeEach(() => vi.mocked(invoke).mockReset().mockResolvedValue(empty));
afterEach(cleanup);
const mount = (onBusyChange = vi.fn()) => render(<CharacterAugmentationSettings disabled={false} onBusyChange={onBusyChange} />);

it("uses the preconnected model with only a toggle and native confirmation", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(ready);
  mount();
  const toggle = screen.getByRole("checkbox", { name: "캐릭터 누락 보완" });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(toggle).not.toBeChecked();
  vi.mocked(invoke).mockResolvedValueOnce({ ...ready, enabled: true });
  await userEvent.click(toggle);
  expect(invoke).toHaveBeenLastCalledWith("set_character_augmentation_enabled", { enabled: true });
  expect(toggle).toBeChecked();
  expect(screen.getByRole("status")).toHaveTextContent("초기 학습은 나눠 진행");
  vi.mocked(invoke).mockResolvedValueOnce(ready);
  await userEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  expect(screen.getByRole("status")).toHaveTextContent("보완 모델이 준비되어 있습니다.");
});

it("keeps unavailable preinstalled models off without offering a picker", async () => {
  mount();
  expect(await screen.findByRole("status")).toHaveTextContent("보완 모델 설치를 확인");
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("blocks duplicate saves and retains off after a failed enable", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(ready);
  const busy = vi.fn();
  mount(busy);
  const toggle = screen.getByRole("checkbox");
  await waitFor(() => expect(toggle).toBeEnabled());
  let reject!: (reason: Error) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  await userEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeDisabled();
  expect(screen.queryByRole("button", { name: /보완 모델/ })).not.toBeInTheDocument();
  await userEvent.click(toggle);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => reject(new Error("모델 준비 실패")));
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeEnabled();
  expect(busy).toHaveBeenLastCalledWith(false);
});

it("shows environment ownership without allowing ineffective saves", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ...ready, enabled: true, managedByEnvironment: true });
  mount();
  expect(await screen.findByRole("status")).toHaveTextContent("환경 변수로 지정");
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.queryByRole("button", { name: /보완 모델/ })).not.toBeInTheDocument();
});

it("allows disabling when the preconnected model is missing", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ...ready, enabled: true, modelReady: false });
  mount();
  const toggle = screen.getByRole("checkbox");
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(screen.getByRole("status")).toHaveTextContent("보완 모델 설치를 확인");
  vi.mocked(invoke).mockResolvedValueOnce({ ...ready, enabled: false, modelReady: false });
  await userEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeDisabled();
});

it("recovers a failed settings read without changing any setting", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("읽기 실패"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("읽기 실패");
  expect(screen.getByRole("checkbox")).toBeDisabled();
  vi.mocked(invoke).mockResolvedValueOnce(ready);
  await userEvent.click(screen.getByRole("button", { name: "보완 설정 다시 확인" }));
  await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(vi.mocked(invoke).mock.calls.every(([command]) => command === "character_augmentation_settings")).toBe(true);
});

it("offers baseline setup without starting augmentation when no runtime is configured", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ...empty, runtimeConfigured: false });
  mount();
  const setup = await screen.findByRole("button", { name: "분석 환경 설정" });
  expect(screen.getByRole("checkbox")).toBeDisabled();
  vi.mocked(invoke).mockResolvedValueOnce(false);
  await userEvent.click(setup);
  expect(invoke).toHaveBeenLastCalledWith("setup_character_runtime");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
});
