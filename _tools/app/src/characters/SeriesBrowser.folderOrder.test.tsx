import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { createCharacterFixture, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { ClassificationEntry, LibraryGateway } from "../library/types";
import type { CharacterHubApi } from "./hubApi";

beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 850 },
  clientHeight: { configurable: true, get: () => 650 },
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const folder = (id: string, name: string): ClassificationEntry => ({ id, kind: "tag", name, parentId: "series", iconKey: null, colorKey: null });
// "child" is the linked character folder: it is a child of the series but never on the shelf.
const classifications = [...fixtureClassifications, folder("sub-a", "백합"), folder("sub-b", "레트로"), folder("sub-c", "기타 만화")];
const shelfFolders = [
  { classificationId: "sub-a", thumbnailAssetId: null, isSeries: true },
  { classificationId: "sub-b", thumbnailAssetId: null },
  { classificationId: "sub-c", thumbnailAssetId: null, isSeries: true },
];

async function setup(props: { classificationOrderIds?: string[]; onReorderFolders?: (parentId: string, ids: string[]) => Promise<void> }) {
  const api = createCharacterFixture();
  const targets = await api.targets();
  const hubApi = { seriesFolders: vi.fn().mockResolvedValue(shelfFolders), browse: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }),
    excludedAssets: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const view = render(<LibraryProvider gateway={{} as LibraryGateway}>
    <SeriesBrowser series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targets={targets}
      classifications={classifications} galleryLayout="masonry" onGalleryLayoutChange={vi.fn()} privacyMode={false} onPrivacyModeChange={vi.fn()}
      metadataVisible onMetadataVisibleChange={vi.fn()} thumbnailRowHeight={180} onThumbnailRowHeightChange={vi.fn()}
      refreshVersion={0} onNavigate={vi.fn()} onChanged={vi.fn()} api={api} hubApi={hubApi} {...props} />
  </LibraryProvider>);
  await screen.findByRole("button", { name: "백합 시리즈 열기" });
  return view;
}
const shelfOrder = () => screen.getAllByRole("button").map(button => button.getAttribute("aria-label") ?? "")
  .filter(label => /(폴더|시리즈) 열기$/.test(label)).map(label => label.replace(/ (폴더|시리즈) 열기$/, ""));

it("shows the sub-folder band in the sidebar's order, falling back to the name", async () => {
  await setup({ classificationOrderIds: ["sub-c", "child"], onReorderFolders: vi.fn() });
  // 기타 만화 is ranked; 레트로 and 백합 follow by name.
  expect(shelfOrder()).toEqual(["기타 만화", "레트로", "백합"]);
});

it("keeps the order it was read in when the owner gives no folder order", async () => {
  await setup({});
  expect(shelfOrder()).toEqual(["백합", "레트로", "기타 만화"]);
  fireEvent.contextMenu(screen.getByRole("button", { name: "백합 시리즈 열기" }));
  expect(screen.queryByRole("menuitem", { name: "뒤로" })).not.toBeInTheDocument();
});

it("stores a menu move with the series' complete child list, the linked character folder staying in its place", async () => {
  const onReorderFolders = vi.fn().mockResolvedValue(undefined);
  await setup({ classificationOrderIds: ["sub-c", "child", "sub-b"], onReorderFolders });
  // Sidebar order: 기타 만화, (히나), 레트로, 백합.
  expect(shelfOrder()).toEqual(["기타 만화", "레트로", "백합"]);
  fireEvent.contextMenu(screen.getByRole("button", { name: "기타 만화 시리즈 열기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "뒤로" }));
  expect(onReorderFolders).toHaveBeenCalledWith("series", ["sub-b", "child", "sub-c", "sub-a"]);
  fireEvent.contextMenu(screen.getByRole("button", { name: "백합 시리즈 열기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "맨 앞으로" }));
  expect(onReorderFolders).toHaveBeenLastCalledWith("series", ["sub-a", "child", "sub-c", "sub-b"]);
});

it("moves a sub-folder with Alt+arrows and offers a retry when storing fails", async () => {
  const onReorderFolders = vi.fn().mockRejectedValueOnce(new Error("저장 실패")).mockResolvedValue(undefined);
  await setup({ classificationOrderIds: ["sub-c", "child", "sub-b", "sub-a"], onReorderFolders });
  const user = userEvent.setup();
  screen.getByRole("button", { name: "레트로 폴더 열기" }).focus();
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  expect(onReorderFolders).toHaveBeenCalledWith("series", ["sub-b", "child", "sub-c", "sub-a"]);
  const toast = (await screen.findByText("순서를 바꾸지 못했습니다")).closest<HTMLElement>("[role='alert'], [role='status']")!;
  await user.click(within(toast).getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(onReorderFolders).toHaveBeenCalledTimes(2));
  expect(onReorderFolders).toHaveBeenLastCalledWith("series", ["sub-b", "child", "sub-c", "sub-a"]);
});
