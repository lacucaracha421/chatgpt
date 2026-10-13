import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useContext, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { MenuItem } from "../shared/ui/Menu";
import type { ClassificationEntry } from "../library/types";
import { CharacterFolderContent } from "./CharacterFolderContent";
import { CharacterFolderGroupDialog } from "./CharacterFolderGroupDialog";
import { FolderRegistrationContext } from "./FolderRegistrationContext";
import { folderGroupApi, type FolderGroupPreview } from "./folderGroupApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const seriesScreen = vi.hoisted(() => ({ ready: true }));
vi.mock("./SeriesBrowser", () => ({ SeriesBrowser: () => <div aria-busy={!seriesScreen.ready}>시리즈 내용</div> }));
vi.mock("./CharacterFolderOrganizer", () => ({ CharacterFolderOrganizer: () => null }));
// Inspect the items supplied to the shared menu; its own keyboard/portal tests cover presentation.
vi.mock("../shared/ui/Menu", () => ({ Menu: ({ label, items }: { label: string; items: MenuItem[] }) =>
  <div aria-label={label}>{items.map(item => <button key={item.id} onClick={item.onSelect}>{item.label}</button>)}</div> }));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  seriesScreen.ready = true;
  vi.mocked(invoke).mockResolvedValue([]);
});

const preview: FolderGroupPreview = {
  folderId: "plain", folderName: "페르소나", seriesId: "series", seriesName: "기타 게임",
  groupName: "페르소나", groupId: null, characterAssetCount: 2, unassignedAssetCount: 3,
  otherAssetCount: 1, parentName: "중간 폴더", refusal: null, token: "preview-token",
};
function api(value = preview) {
  return { preview: vi.fn(async () => value), apply: vi.fn(async () => ({ seriesId: "series", groupId: "group" })) };
}

describe("그룹으로 정리 dialog", () => {
  it("shows the destination, new 기타-only group, counts, other assets and deletion before writing", async () => {
    const commands = api();
    render(<CharacterFolderGroupDialog folderId="plain" api={commands} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("‘기타 게임’ 시리즈 폴더로 옮깁니다.")).toBeInTheDocument();
    expect(screen.getByText("기타만 있는 ‘페르소나’ 그룹을 만듭니다.")).toBeInTheDocument();
    expect(screen.getByText(/캐릭터가 있는 이미지·영상·GIF 2개/)).toBeInTheDocument();
    expect(screen.getByText(/캐릭터가 없는 이미지·영상·GIF 3개/)).toBeInTheDocument();
    expect(screen.getByText(/그 밖의 자산 1개.*중간 폴더/)).toBeInTheDocument();
    expect(screen.getByText("정리가 끝나면 이 폴더를 삭제합니다.")).toBeInTheDocument();
    expect(commands.apply).not.toHaveBeenCalled();
  });

  it("shows existing group reuse", async () => {
    render(<CharacterFolderGroupDialog folderId="plain" api={api({ ...preview, groupId: "group" })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("같은 이름의 ‘페르소나’ 그룹을 사용합니다.")).toBeInTheDocument();
  });

  it("keeps apply disabled while the preview is pending", async () => {
    let resolve!: (value: FolderGroupPreview) => void;
    const commands = { ...api(), preview: vi.fn(() => new Promise<FolderGroupPreview>(yes => { resolve = yes; })) };
    render(<CharacterFolderGroupDialog folderId="plain" api={commands} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole("button", { name: "그룹으로 정리" })).toBeDisabled();
    await act(async () => resolve(preview));
    expect(screen.getByRole("button", { name: "그룹으로 정리" })).toBeEnabled();
  });

  it.each(["하위 폴더가 있습니다.", "여러 폴더에 들어 있는 자산입니다.", "분류에서 제외된 자산입니다.", "폴더가 비어 있습니다."])("shows refusal and disables apply: %s", async refusal => {
    const commands = api({ ...preview, refusal });
    render(<CharacterFolderGroupDialog folderId="plain" api={commands} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(screen.getByRole("button", { name: "그룹으로 정리" })).toBeDisabled();
    expect(commands.apply).not.toHaveBeenCalled();
  });

  it("passes the preview token to apply and closes through onSaved", async () => {
    const commands = api(), saved = vi.fn();
    render(<CharacterFolderGroupDialog folderId="plain" api={commands} onClose={vi.fn()} onSaved={saved} />);
    await screen.findByText("페르소나");
    fireEvent.click(screen.getByRole("button", { name: "그룹으로 정리" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ seriesId: "series", groupId: "group" }));
    expect(commands.apply).toHaveBeenCalledExactlyOnceWith("plain", "preview-token");
  });

  it("requires a fresh preview after a stale apply failure", async () => {
    const commands = api();
    commands.apply.mockRejectedValueOnce({ code: "character_stale", message: "내용이 바뀌었습니다." });
    commands.preview.mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, token: "new-token" });
    const saved = vi.fn();
    render(<CharacterFolderGroupDialog folderId="plain" api={commands} onClose={vi.fn()} onSaved={saved} />);
    await screen.findByText("페르소나");
    fireEvent.click(screen.getByRole("button", { name: "그룹으로 정리" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("내용이 바뀌었습니다.");
    expect(screen.getByRole("button", { name: "그룹으로 정리" })).toBeDisabled();
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 확인" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "그룹으로 정리" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "그룹으로 정리" }));
    await waitFor(() => expect(commands.apply).toHaveBeenLastCalledWith("plain", "new-token"));
  });

  it("uses the native command names and arguments", async () => {
    await folderGroupApi.preview("plain");
    await folderGroupApi.apply("plain", "token");
    expect(invoke).toHaveBeenCalledWith("character_folder_group_preview", { folderId: "plain" });
    expect(invoke).toHaveBeenCalledWith("tidy_character_folder_into_group", { folderId: "plain", token: "token" });
  });
});

const folder = (id: string, name: string, parentId: string | null): ClassificationEntry =>
  ({ id, name, parentId, kind: parentId ? "tag" : "root", iconKey: null, colorKey: null });
const classifications = [folder("root", "게임", null), folder("series", "기타 게임", "root"),
  folder("middle", "중간 폴더", "series"), folder("plain", "페르소나", "middle")];
function MenuSlot() { return <>{useContext(FolderRegistrationContext)}</>; }
function props(): ComponentProps<typeof CharacterFolderContent> {
  return {
    children: <><MenuSlot /><p>폴더 내용</p></>, view: { kind: "classification", classificationId: "plain" },
    hub: { series: [{ classificationId: "series", heroAssetId: null, autoClassify: true }],
      targets: [], extras: [], groups: [], error: null, refresh: vi.fn(), revision: 0,
      seriesRevisions: {}, seriesAnalysed: vi.fn(), reorderGroups: vi.fn(), reorderCharacters: vi.fn() },
    classifications, galleryLayout: "masonry", onGalleryLayoutChange: vi.fn(), privacyMode: false,
    onPrivacyModeChange: vi.fn(), metadataVisible: true, onMetadataVisibleChange: vi.fn(),
    thumbnailRowHeight: 200, onThumbnailRowHeightChange: vi.fn(), refreshVersion: 0,
    onNavigate: vi.fn(), onAssetsChanged: vi.fn(),
  };
}

describe("plain folder menu", () => {
  it("offers 그룹으로 정리 beneath the nearest registered ancestor, including an intermediate plain folder", async () => {
    render(<CharacterFolderContent {...props()} />);
    expect(await screen.findByRole("button", { name: "그룹으로 정리" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "시리즈로 등록" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "캐릭터로 만들기" })).toBeInTheDocument();
  });

  it.each(["outside-series", "originals", "excluded", "inherited-exclusion", "series-itself"])("hides the action in %s", async scope => {
    const value = props();
    if (scope === "outside-series") value.hub = { ...value.hub, series: [] };
    if (scope === "originals") value.classifications = [folder("lakomics-originals", "오리지널", null),
      folder("series", "기타 게임", "lakomics-originals"), ...classifications.slice(2)];
    if (scope === "excluded" || scope === "inherited-exclusion") vi.mocked(invoke).mockResolvedValue(scope === "excluded" ? ["plain"] : ["middle"]);
    if (scope === "series-itself") value.view = { kind: "classification", classificationId: "series" };
    render(<CharacterFolderContent {...value} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "그룹으로 정리" })).not.toBeInTheDocument();
  });

  it("closes after apply, refreshes the hub and navigates to the series", async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "character_folder_group_preview") return preview;
      if (command === "tidy_character_folder_into_group") return { seriesId: "series", groupId: "group" };
      return [];
    });
    const value = props();
    render(<CharacterFolderContent {...value} />);
    fireEvent.click(await screen.findByRole("button", { name: "그룹으로 정리" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("페르소나");
    fireEvent.click(within(dialog).getByRole("button", { name: "그룹으로 정리" }));
    await waitFor(() => expect(value.onNavigate).toHaveBeenCalledWith({ kind: "classification", classificationId: "series" }));
    expect(value.hub.refresh).toHaveBeenCalledOnce();
    expect(value.onAssetsChanged).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the dialog immediately while keeping the old folder until the series is ready", async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "character_folder_group_preview") return preview;
      if (command === "tidy_character_folder_into_group") return { seriesId: "series", groupId: "group" };
      return [];
    });
    const value = props();
    seriesScreen.ready = false;
    const view = render(<CharacterFolderContent {...value} />);
    value.onNavigate = vi.fn(next => view.rerender(<CharacterFolderContent {...value} view={next} classifications={classifications.filter(entry => entry.id !== "plain")} />));
    view.rerender(<CharacterFolderContent {...value} />);
    fireEvent.click(await screen.findByRole("button", { name: "그룹으로 정리" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("페르소나");
    fireEvent.click(within(dialog).getByRole("button", { name: "그룹으로 정리" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("폴더 내용")).toBeInTheDocument();
    expect(screen.getByText("폴더 내용").closest("[inert]")).not.toBeNull();
    expect(screen.getByText("시리즈 내용").closest("[data-preparing]")).not.toBeNull();
    seriesScreen.ready = true;
    view.rerender(<CharacterFolderContent {...value} view={{ kind: "classification", classificationId: "series" }} />);
    await waitFor(() => expect(screen.queryByText("폴더 내용")).not.toBeInTheDocument());
    expect(screen.getByText("시리즈 내용").closest("[data-preparing]")).toBeNull();
  });
});
