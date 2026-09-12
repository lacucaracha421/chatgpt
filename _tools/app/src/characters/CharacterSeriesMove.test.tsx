import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CharacterSeriesMove } from "./CharacterSeriesMove";
import { fixtureTarget } from "./characterFixtures";
import type { ClassificationEntry } from "../library/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const target = fixtureTarget("lorentz", "로렌츠");
const entries: ClassificationEntry[] = [
  { id: "series", name: "리버스", kind: "root", parentId: null, iconKey: null, colorKey: null },
  { id: "laplace", name: "라플라스", kind: "tag", parentId: "series", iconKey: null, colorKey: null },
  { id: "ordinary", name: "일반 폴더", kind: "tag", parentId: "series", iconKey: null, colorKey: null },
  { id: "another", name: "다른 시리즈", kind: "root", parentId: null, iconKey: null, colorKey: null },
];
const preview = { targetId: target.id, destinationId: "laplace", assetCount: 12, relocationCount: 8, sharedCount: 2, groupName: "라플라스", token: "preview-token" };
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockImplementation(async command => {
    if (command === "character_series") return ["series", "laplace", "another"].map(classificationId => ({ classificationId, autoClassify: true, heroAssetId: null }));
    if (command === "character_series_move_preview") return preview;
    if (command === "move_character_to_series") return { ...target, seriesClassificationId: "laplace" };
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

it.each([0, 4])("shows shared common-folder placement separately and enables moving (%i relocated)", async relocationCount => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args, options) => command === "character_series_move_preview"
    ? Promise.resolve({ ...preview, assetCount: 119, relocationCount: 115 + relocationCount, sharedCount: 4,
      sharedLocations: [{ classificationId: "series", assetCount: 4, relocationCount }] })
    : original(command, args, options));
  const user = userEvent.setup();
  render(<CharacterSeriesMove target={target} entries={entries} onClose={vi.fn()} onMoved={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  await user.selectOptions(screen.getByRole("combobox"), "laplace");
  expect(await screen.findByText(/119개 중 115개/)).toBeVisible();
  expect(screen.getByText(`리버스 · 4개 · ${relocationCount ? "4개 이동" : "현재 위치 유지"}`)).toBeVisible();
  expect(screen.getByText(/다른 캐릭터와 공유하는 4개의 연결도 유지/)).toBeVisible();
  expect(screen.getByRole("button", { name: "이동" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "이동" }));
  expect(vi.mocked(invoke).mock.calls.map(call => call[0])).toEqual(["character_series", "character_series_move_preview", "move_character_to_series"]);
});

it("requires a current preview, preserves settings and never requests analysis", async () => {
  const user = userEvent.setup(), onMoved = vi.fn();
  render(<CharacterSeriesMove target={target} entries={entries} onClose={vi.fn()} onMoved={onMoved} />);
  const select = await screen.findByRole("combobox", { name: "대상 시리즈" });
  await waitFor(() => expect(select).toBeEnabled());
  expect(screen.queryByRole("option", { name: "일반 폴더" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "리버스" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "이동" })).toBeDisabled();
  await user.selectOptions(select, "laplace");
  expect(await screen.findByText(/12개 중 8개/)).toBeVisible();
  expect(screen.getByText(/기존 ‘라플라스’ 그룹에서는 빠집니다/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "이동" }));
  expect(invoke).toHaveBeenCalledWith("move_character_to_series", { targetId: target.id, destinationId: "laplace", token: preview.token });
  expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ id: target.id, seriesClassificationId: "laplace" }));
  expect(vi.mocked(invoke).mock.calls.map(call => call[0])).toEqual(["character_series", "character_series_move_preview", "move_character_to_series"]);
});

it("discards an earlier destination preview and does not move on cancel", async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "character_series") return ["laplace", "another"].map(classificationId => ({ classificationId }));
    if ((args as { destinationId: string }).destinationId === "laplace") return new Promise(resolve => { resolveOld = resolve; });
    return { ...preview, destinationId: "another", token: "new-token", assetCount: 20 };
  });
  const user = userEvent.setup(), onClose = vi.fn();
  render(<CharacterSeriesMove target={target} entries={entries} onClose={onClose} onMoved={vi.fn()} />);
  const select = screen.getByRole("combobox");
  await waitFor(() => expect(select).toBeEnabled());
  await user.selectOptions(select, "laplace");
  await user.selectOptions(select, "another");
  expect(await screen.findByText(/20개 중/)).toBeVisible();
  resolveOld(preview);
  await waitFor(() => expect(screen.queryByText(/12개 중/)).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "취소" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalledWith("move_character_to_series", expect.anything());
});

it("blocks repeated submission after stale failure until a new preview is checked", async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args, options) => command === "move_character_to_series"
    ? Promise.reject(new Error("설정이 바뀌었습니다.")) : original(command, args, options));
  const user = userEvent.setup();
  render(<CharacterSeriesMove target={target} entries={entries} onClose={vi.fn()} onMoved={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  await user.selectOptions(screen.getByRole("combobox"), "laplace");
  await waitFor(() => expect(screen.getByRole("button", { name: "이동" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "이동" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("설정이 바뀌었습니다.");
  expect(screen.getByRole("button", { name: "이동" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "다시 확인" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "이동" })).toBeEnabled());
  expect(vi.mocked(invoke).mock.calls.filter(call => call[0] === "character_series_move_preview")).toHaveLength(2);
});
