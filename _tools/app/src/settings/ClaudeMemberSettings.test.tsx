import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { ClaudeMemberSettings } from "./ClaudeMemberSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const initial = { state: "idle", planId: null as string | null, buckets: [2, 3, 4], estimateLowUsd: .039, estimateHighUsd: .44,
  total: 9, done: 0, failed: 0, capUsd: 45, spentUsd: 0, reservedUsd: 0, remainingUsd: 45,
  ongoingEnabled: true, ongoingUntilCutoff: true };
let current = { ...initial };
let excluded = [{ id: "real", path: "기타 › 실사" }, { id: "meme", path: "기타 › 밈" }];
beforeEach(() => {
  current = { ...initial };
  excluded = [{ id: "real", path: "기타 › 실사" }, { id: "meme", path: "기타 › 밈" }];
  vi.mocked(invoke).mockImplementation((async (command: string, args?: Record<string, unknown>) => {
    if (command === "claude_member_status") return current;
    if (command === "claude_member_excluded_folders") return excluded;
    if (command === "claude_member_set_excluded_folders") {
      const ids = args?.ids as string[];
      const known = [...excluded, { id: "design", path: "기타 › 디자인" }];
      excluded = ids.map(id => known.find(folder => folder.id === id)!);
      return excluded;
    }
    if (command === "claude_member_plan") { current = { ...current, state: "draft", planId: "frozen-plan" }; return current; }
    if (command === "claude_member_control") {
      const state = ({ start: "running", pause: "paused", resume: "running", cancel: "cancelled" } as Record<string, string>)[String(args?.action)] ?? current.state;
      current = { ...current, state, capUsd: (args?.capUsd as number | undefined) ?? current.capUsd,
        ongoingEnabled: (args?.ongoingEnabled as boolean | undefined) ?? current.ongoingEnabled };
      return current;
    }
    throw new Error(`Unexpected ${command}`);
  }) as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("previews the frozen cohort before starting and supports pause and resume", async () => {
  const user = userEvent.setup();
  render(<ClaudeMemberSettings disabled={false} />);
  const preview = await screen.findByRole("button", { name: "대상 확인" });
  await waitFor(() => expect(preview).toBeEnabled());
  await user.click(preview);
  const dialog = await screen.findByRole("dialog", { name: "미분류 이미지 분석" });
  expect(vi.mocked(invoke).mock.calls.some(([, args]) => (args as { action?: string })?.action === "start")).toBe(false);
  for (const n of [2, 3, 4]) expect(within(dialog).getByText(`${n}장`)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "분석 시작" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_member_control", { action: "start", planId: "frozen-plan" }));
  await user.click(await screen.findByRole("button", { name: "일시 정지" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_member_control", { action: "pause" }));
  await user.click(await screen.findByRole("button", { name: "다시 시작" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_member_control", { action: "resume" }));
});
it("saves the dedicated cap and ongoing switch independently", async () => {
  const user = userEvent.setup();
  render(<ClaudeMemberSettings disabled={false} />);
  const field = await screen.findByRole("spinbutton", { name: "분석 한도 ($)" });
  await waitFor(() => expect(field).toBeEnabled());
  await user.clear(field); await user.type(field, "60");
  await user.click(screen.getByRole("button", { name: "분석 한도 저장" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_member_control", { action: "settings", capUsd: 60 }));
  await user.click(screen.getByRole("switch", { name: "신규 이미지 자동 분석" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_member_control", { action: "settings", ongoingEnabled: false }));
  expect(invoke).not.toHaveBeenCalledWith("set_claude_settings", expect.anything());
});
it("lists excluded folders, removes one and adds one from the shared folder picker", async () => {
  const user = userEvent.setup();
  const gateway = { listClassifications: vi.fn().mockResolvedValue([
    { id: "etc", kind: "root", name: "기타", parentId: null, assetCount: 0 },
    { id: "real", kind: "tag", name: "실사", parentId: "etc", assetCount: 5 },
    { id: "design", kind: "tag", name: "디자인", parentId: "etc", assetCount: 7 },
  ]) } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><ClaudeMemberSettings disabled={false} /></LibraryProvider>);
  const list = await screen.findByRole("list", { name: "분석에서 제외한 폴더" });
  expect(within(list).getByText("기타 › 실사")).toBeInTheDocument();
  await user.click(within(list).getByRole("button", { name: "기타 › 밈 제외 해제" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_member_set_excluded_folders", { ids: ["real"] }));
  await waitFor(() => expect(within(list).queryByText("기타 › 밈")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "추가" }));
  await user.click(await screen.findByRole("option", { name: /기타 › 디자인/ }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_member_set_excluded_folders", { ids: ["real", "design"] }));
  expect(await screen.findByText("기타 › 디자인")).toBeInTheDocument();
});
