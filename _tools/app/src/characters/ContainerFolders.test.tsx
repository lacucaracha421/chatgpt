import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LibraryProvider } from "../library/LibraryContext";
import type { ClassificationEntry, LibraryGateway } from "../library/types";
import { SeriesPicker } from "./SeriesPicker";
import { RegistrationScope, type RegistrationPreview } from "./RegistrationScope";
import { ContainerFolderDialog } from "./ContainerFolderDialog";
import { NewManualCharacter } from "./NewManualCharacter";
import { fixtureTarget } from "./characterFixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
const root: ClassificationEntry = { id: "games", name: "게임", kind: "root", parentId: null, iconKey: null, colorKey: null, isContainer: true };
const small: ClassificationEntry = { ...root, id: "small", name: "이환", parentId: root.id, kind: "tag", isContainer: false, totalAssetCount: 12 };
const large: ClassificationEntry = { ...small, id: "large", name: "리버스", totalAssetCount: 2659 };
const entries = [root, small, large];
const create = vi.fn();
let preview: RegistrationPreview;
beforeEach(() => {
  preview = { imageCount: 12, otherSeries: false };
  const registered = [small.id, large.id];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "character_registration_preview") return preview;
    if (command === "character_series") return registered.map(classificationId => ({ classificationId, heroAssetId: null, autoClassify: true }));
    if (command === "save_character_series") registered.push((args as { request: { classificationId: string } }).request.classificationId);
    if (command === "create_manual_character") return { ...fixtureTarget("created", "민트"), seriesClassificationId: (args as { request: { seriesId: string } }).request.seriesId };
    if (command === "character_series_move_preview") return { token: "current" };
    return undefined;
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function provider(children: React.ReactNode) { return <LibraryProvider gateway={{ createClassification: create } as unknown as LibraryGateway}>{children}</LibraryProvider>; }
function scope(save = vi.fn()) {
  render(provider(<RegistrationScope request={{ seriesId: small.id, mode: "suggestion", referenceIds: ["1", "2", "3", "4", "5"] }} entries={entries} onSeriesSelected={vi.fn()}>
    {(guard, pending) => <button disabled={pending} onClick={() => guard(save)}>등록</button>}
  </RegistrationScope>));
  return save;
}
it("lists child series by image count and creates a child series inline", async () => {
  const selected = vi.fn();
  const next = { ...small, id: "new", name: "새 작품" };
  create.mockResolvedValue(next);
  render(provider(<SeriesPicker parent={root} entries={entries} onClose={vi.fn()} onSelected={selected} />));
  const user = userEvent.setup();
  const rows = await screen.findAllByRole("button", { name: /장$/ });
  expect(rows.map(row => row.textContent)).toEqual(["리버스2,659장", "이환12장"]);
  await user.click(screen.getByRole("button", { name: "새 시리즈" }));
  await user.type(screen.getByRole("textbox", { name: "새 시리즈 이름" }), "새 작품");
  await user.click(screen.getByRole("button", { name: "만들기" }));
  await waitFor(() => expect(selected).toHaveBeenCalledWith(next));
  expect(create).toHaveBeenCalledWith({ kind: "tag", name: "새 작품", parentId: "games" });
  expect(invoke).toHaveBeenCalledWith("save_character_series", { request: { classificationId: "new", heroAssetId: null, autoClassify: true } });
});
it("continues manual creation after the series choice without an extra scope confirmation", async () => {
  preview = { imageCount: 0, otherSeries: false };
  const saved = vi.fn();
  render(provider(<NewManualCharacter name="민트" series={root} entries={entries} assetIds={["image"]} onClose={vi.fn()} onSaved={saved} />));
  await userEvent.click(await screen.findByRole("button", { name: /이환.*12장/ }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(expect.objectContaining({ id: "created", seriesClassificationId: small.id })));
  expect(invoke).toHaveBeenCalledWith("character_registration_preview", { request: { seriesId: small.id, mode: "manual" } });
  expect(screen.queryByRole("dialog", { name: /캐릭터 등록/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/다시 확인합니다/)).not.toBeInTheDocument();
});
it("shows a small scope in one line and registers directly", async () => {
  const save = scope();
  expect(await screen.findByText("이환 폴더 이미지 12장을 다시 확인합니다")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("waits until the registration scope is visible before enabling registration", async () => {
  let ready!: (value: RegistrationPreview) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
  const save = scope();
  expect(screen.getByRole("button", { name: "등록" })).toBeDisabled();
  await act(async () => ready(preview));
  expect(screen.getByText("이환 폴더 이미지 12장을 다시 확인합니다")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});
it("confirms 1000 or more images with the count in the primary action", async () => {
  preview = { imageCount: 1000, otherSeries: false };
  const save = scope();
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  const dialog = await screen.findByRole("dialog", { name: "캐릭터 등록" });
  expect(save).not.toHaveBeenCalled();
  expect(within(dialog).getByText("많은 이미지를 다시 확인합니다")).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "1,000장 확인하고 등록" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});
it("prioritizes choosing a child series when other series are included", async () => {
  preview = { imageCount: 12, otherSeries: true };
  const save = scope();
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  const dialog = await screen.findByRole("dialog", { name: "캐릭터 등록" });
  expect(within(dialog).getByText("다른 시리즈가 범위에 들어 있습니다").parentElement).toHaveClass("registration-scope__notice--warning");
  expect(within(dialog).getByRole("button", { name: "하위 시리즈 고르기" })).toHaveClass("ui-button--primary");
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole("button", { name: "그대로 등록" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});
it("keeps zero scope silent for a manual character", async () => {
  preview = { imageCount: 0, otherSeries: true };
  const save = scope();
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(screen.queryByText(/다시 확인합니다/)).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("moves each character using the existing move command before marking the folder", async () => {
  const saved = vi.fn();
  render(provider(<ContainerFolderDialog folder={root} targets={[{ ...fixtureTarget("character", "민트"), seriesClassificationId: root.id }]} entries={entries} onClose={vi.fn()} onSaved={saved} />));
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "분류함으로 바꾸기" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "시리즈 고르기" }));
  await user.click(await screen.findByRole("button", { name: /이환.*12장/ }));
  await user.click(screen.getByRole("button", { name: "분류함으로 바꾸기" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("move_character_to_series", { targetId: "character", destinationId: "small", token: "current" });
  expect(invoke).toHaveBeenCalledWith("set_character_container", { folderId: "games", enabled: true });
  const commands = vi.mocked(invoke).mock.calls.map(call => call[0]);
  expect(commands.indexOf("move_character_to_series")).toBeLessThan(commands.indexOf("set_character_container"));
  expect(commands).not.toContain("request_character_reference_refresh");
});

it("offers an inline-created series to the next character in the same conversion", async () => {
  create.mockResolvedValue({ ...small, id: "new", name: "새 작품", totalAssetCount: 0 });
  const saved = vi.fn();
  const targets = [fixtureTarget("first", "민트"), fixtureTarget("second", "블로니")].map(target => ({ ...target, seriesClassificationId: root.id }));
  render(provider(<ContainerFolderDialog folder={root} targets={targets} entries={entries} onClose={vi.fn()} onSaved={saved} />));
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "시리즈 고르기" })[0]!);
  await user.click(screen.getByRole("button", { name: "새 시리즈" }));
  await user.type(screen.getByRole("textbox", { name: "새 시리즈 이름" }), "새 작품");
  await user.click(screen.getByRole("button", { name: "만들기" }));
  await user.click(await screen.findByRole("button", { name: "시리즈 고르기" }));
  await user.click(await screen.findByRole("button", { name: /새 작품.*0장/ }));
  await user.click(screen.getByRole("button", { name: "분류함으로 바꾸기" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("move_character_to_series", { targetId: "first", destinationId: "new", token: "current" });
  expect(invoke).toHaveBeenCalledWith("move_character_to_series", { targetId: "second", destinationId: "new", token: "current" });
});
