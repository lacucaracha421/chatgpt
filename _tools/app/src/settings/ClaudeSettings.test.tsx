import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClaudeSettings, type ClaudeStatus } from "./ClaudeSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const status = (patch: Partial<ClaudeStatus> = {}): ClaudeStatus => ({
  state: "idle", done: 0, total: 0, spentUsd: 1.5, capUsd: 10, autoAccepted: 5, autoRejected: 2, leftForUser: 3, lastRunAt: null, ...patch,
});

type Backend = { configured: boolean; enabled: boolean; cap: number; status: ClaudeStatus };
let backend: Backend;
const calls = () => vi.mocked(invoke).mock.calls.filter(([command]) => !["claude_status", "claude_credential_status", "claude_settings"].includes(command));

beforeEach(() => {
  backend = { configured: true, enabled: true, cap: 10, status: status() };
  vi.mocked(invoke).mockImplementation((async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "claude_credential_status": return { configured: backend.configured };
      case "claude_settings": return { enabled: backend.enabled, monthlyCapUsd: backend.cap };
      case "claude_status": return backend.status;
      case "set_claude_credential": backend.configured = true; return { configured: true };
      case "delete_claude_credential": backend.configured = false; return { configured: false };
      case "set_claude_settings": backend.enabled = args?.enabled as boolean; backend.cap = args?.monthlyCapUsd as number; return { enabled: backend.enabled, monthlyCapUsd: backend.cap };
      default: return undefined;
    }
  }) as never);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it("shows only the key at first: without a key the switch and the cap stay off", async () => {
  backend = { configured: false, enabled: false, cap: 10, status: status({ state: "no_key" }) };
  render(<ClaudeSettings />);
  expect(await screen.findByText("없음")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "자동 판정" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "월 한도" })).toBeDisabled();
  expect(await screen.findByText("API 키를 넣으면 시작할 수 있습니다")).toBeInTheDocument();
});

it("saves a trimmed key without showing it again, then lets the switch work", async () => {
  backend = { configured: false, enabled: false, cap: 10, status: status({ state: "no_key" }) };
  const user = userEvent.setup();
  render(<ClaudeSettings />);
  await user.click(await screen.findByRole("button", { name: "Claude API 키 입력" }));
  const field = screen.getByLabelText("Claude API 키 입력", { selector: "input" });
  expect(field).toHaveAttribute("type", "password");
  expect(field).toHaveAttribute("placeholder", "API 키 (sk-ant-…)");
  await user.type(field, "  sk-ant-abc  ");
  await user.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(calls()).toEqual([["set_claude_credential", { key: "sk-ant-abc" }]]));
  expect(await screen.findByText("설정됨")).toBeInTheDocument();
  expect(screen.queryByDisplayValue(/sk-ant/)).toBeNull();
  await waitFor(() => expect(screen.getByRole("switch", { name: "자동 판정" })).toBeEnabled());
});

it("shows a failed save as an alert and keeps what was typed", async () => {
  backend = { configured: false, enabled: false, cap: 10, status: status({ state: "no_key" }) };
  vi.mocked(invoke).mockImplementation((async (command: string) => {
    if (command === "claude_credential_status") return { configured: false };
    if (command === "claude_status") return backend.status;
    if (command === "set_claude_credential") throw new Error("Claude API 키가 올바르지 않습니다");
    return undefined;
  }) as never);
  const user = userEvent.setup();
  render(<ClaudeSettings />);
  await user.click(await screen.findByRole("button", { name: "Claude API 키 입력" }));
  await user.type(screen.getByLabelText("Claude API 키 입력", { selector: "input" }), "bad key");
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Claude API 키가 올바르지 않습니다");
  expect(screen.getByLabelText("Claude API 키 입력", { selector: "input" })).toHaveValue("bad key");
});

it("deletes the key after a confirmation", async () => {
  const user = userEvent.setup();
  render(<ClaudeSettings />);
  await user.click(await screen.findByRole("button", { name: "Claude API 키 삭제" }));
  expect(screen.getByText("Claude API 키 설정을 삭제할까요?")).toBeInTheDocument();
  expect(calls()).toEqual([]);
  await user.click(screen.getByRole("button", { name: "삭제 확인" }));
  await waitFor(() => expect(calls()).toEqual([["delete_claude_credential"]]));
  expect(await screen.findByText("없음")).toBeInTheDocument();
});

it("tells the month's tally and spending when idle", async () => {
  render(<ClaudeSettings />);
  expect(await screen.findByText("이번 달 자동 처리 7건 · 확인 필요 3건")).toBeInTheDocument();
  expect(screen.getByText("이번 달 $1.50 사용")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "자동 판정" })).toBeChecked();
  expect(screen.getByRole("combobox", { name: "월 한도" })).toHaveValue("10");
  const options = screen.getAllByRole("option").map(option => option.textContent);
  expect(options).toEqual(["$1", "$2", "$5", "$10", "$20", "$50", "$100"]);
});

it("saves the switch and the cap at once", async () => {
  const user = userEvent.setup();
  render(<ClaudeSettings />);
  await user.click(await screen.findByRole("switch", { name: "자동 판정" }));
  await waitFor(() => expect(calls()).toContainEqual(["set_claude_settings", { enabled: false, monthlyCapUsd: 10 }]));
  await user.selectOptions(screen.getByRole("combobox", { name: "월 한도" }), "20");
  await waitFor(() => expect(calls()).toContainEqual(["set_claude_settings", { enabled: false, monthlyCapUsd: 20 }]));
  expect(screen.getByRole("combobox", { name: "월 한도" })).toHaveValue("20");
});

it("shows the run's progress only after 400 ms and then keeps it steady", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  backend.status = status({ state: "running", done: 12, total: 35 });
  render(<ClaudeSettings />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  // Before the delay the line keeps showing the settled tally.
  expect(screen.getByText("이번 달 자동 처리 7건 · 확인 필요 3건")).toBeInTheDocument();
  expect(screen.queryByText("처리 중 12 / 35")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(399); });
  expect(screen.queryByText("처리 중 12 / 35")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("처리 중 12 / 35")).toBeInTheDocument();
  // The numbers move in place with the next status.
  backend.status = status({ state: "running", done: 13, total: 35 });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(screen.getByText("처리 중 13 / 35")).toBeInTheDocument();
  // And the finished run goes back to the tally without a gap.
  backend.status = status({ state: "idle", autoAccepted: 20, autoRejected: 10, leftForUser: 5 });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByText("이번 달 자동 처리 30건 · 확인 필요 5건")).toBeInTheDocument();
});

it("says the month's cap is reached without calling it an error", async () => {
  backend.status = status({ state: "capped", spentUsd: 10.01 });
  render(<ClaudeSettings />);
  const line = await screen.findByText("이번 달 한도 도달");
  expect(line).not.toHaveAttribute("data-tone");
  expect(screen.getByText("이번 달 $10.01 사용")).toBeInTheDocument();
});

it("shows a refused key in the danger colour", async () => {
  backend.status = status({ state: "credential" });
  render(<ClaudeSettings />);
  const line = await screen.findByText("API 키를 확인하세요");
  expect(line).toHaveAttribute("data-tone", "danger");
});

it("keeps an unknown saved cap selectable", async () => {
  backend.cap = 15;
  render(<ClaudeSettings />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "월 한도" })).toHaveValue("15"));
  expect(screen.getByRole("option", { name: "$15" })).toBeInTheDocument();
});
