import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import type { EncryptedVaultFolder, EncryptedVaultItemPage, EncryptedVaultStatus, LibraryGateway } from "../library/types";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { ExternalVaultBrowser } from "./ExternalVaultBrowser";
import { resetVaultExportJob } from "./vaultExportJob";
import { resetVaultImportJob } from "./vaultImportJob";

vi.mock("../assets/AssetGallery", () => ({
  AssetGallery: ({ items, onSelectionGesture, onPointerDragStart, onPointerDragMove, onPointerDragEnd }: any) => <div aria-label="vault gallery">
    {items.map((item: any) => <button key={item.id} data-asset-id={item.id}
      onClick={(event) => onSelectionGesture?.(item, { toggle: event.ctrlKey, range: event.shiftKey })}>{item.originalName}</button>)}
    {onPointerDragStart && <button data-testid="drag" onPointerDown={(event) => onPointerDragStart({ kind: "assets", assetIds: ["a"] }, event)}
      onPointerMove={onPointerDragMove} onPointerUp={onPointerDragEnd}>drag a</button>}
  </div>,
}));
vi.mock("../assets/AssetViewer", () => ({ AssetViewer: () => null }));

afterEach(() => { cleanup(); resetVaultImportJob(); resetVaultExportJob(); });

const unlocked: EncryptedVaultStatus = { state: "unlocked", vaultId: "v", root: "/media/usb", itemCount: 3, remembered: true };
const folders: EncryptedVaultFolder[] = [
  { id: "trip", name: "여행", parentId: null, createdAt: "2026-10-07T00:00:00Z", itemCount: 1, totalItemCount: 2 },
  { id: "sea", name: "바다", parentId: "trip", createdAt: "2026-10-07T00:00:00Z", itemCount: 1, totalItemCount: 1 },
];
const page: EncryptedVaultItemPage = {
  items: [
    { id: "a", kind: "image", byteSize: 1, width: 8, height: 8, title: null, originalFileName: "a.png", importedAt: "2026-10-07T00:00:00Z", hasThumbnail: true, folderId: "sea" },
    { id: "b", kind: "image", byteSize: 1, width: 8, height: 8, title: null, originalFileName: "b.png", importedAt: "2026-10-07T00:00:00Z", hasThumbnail: true, folderId: null },
  ],
  totalCount: 2, nextOffset: null,
};

function vaultGateway(overrides: Partial<LibraryGateway> = {}) {
  return {
    listEncryptedVaultItems: vi.fn().mockResolvedValue(page),
    listEncryptedVaultFolders: vi.fn().mockResolvedValue(folders),
    createEncryptedVaultFolder: vi.fn().mockResolvedValue(folders[0]),
    renameEncryptedVaultFolder: vi.fn().mockResolvedValue(undefined),
    moveEncryptedVaultFolder: vi.fn().mockResolvedValue(undefined),
    deleteEncryptedVaultFolder: vi.fn().mockResolvedValue(undefined),
    moveEncryptedVaultItemsToFolder: vi.fn().mockImplementation((ids: string[]) => Promise.resolve(ids.length)),
    trashEncryptedVaultItems: vi.fn(),
    ...overrides,
  } as unknown as LibraryGateway;
}

function renderVault(gateway: LibraryGateway, status = unlocked) {
  return render(<WorkspaceChromeProvider scope="private_vault">
    <ChromeTarget name="navigation" />
    <ExternalVaultBrowser gateway={gateway} status={status} onStatusChange={vi.fn()} />
  </WorkspaceChromeProvider>);
}

it("fills the empty vault index with 전체, 미분류 and the folder tree that scope the gallery", async () => {
  const gateway = vaultGateway();
  renderVault(gateway);
  const tree = await screen.findByRole("tree", { name: "폴더" });
  expect(screen.getByRole("button", { name: "전체 3개" })).toHaveAttribute("aria-current", "page");
  // 3 items, 2 of them inside 여행 (with its child folder): 1 is unfiled.
  expect(screen.getByRole("button", { name: "미분류 1개" })).toBeInTheDocument();

  await userEvent.click(within(tree).getByRole("treeitem", { name: "여행" }));
  await waitFor(() => expect(gateway.listEncryptedVaultItems).toHaveBeenLastCalledWith({ kind: null, offset: 0, limit: 80, folderId: "trip" }));
  expect(within(tree).getByRole("treeitem", { name: "여행" })).toHaveAttribute("aria-selected", "true");
  await userEvent.click(within(tree).getByRole("button", { name: "여행 펼치기" }));
  expect(within(tree).getByRole("treeitem", { name: "바다" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "미분류 1개" }));
  await waitFor(() => expect(gateway.listEncryptedVaultItems).toHaveBeenLastCalledWith({ kind: null, offset: 0, limit: 80, unfiledOnly: true }));
  // The trash is not scoped by folders.
  await userEvent.click(screen.getByRole("button", { name: "휴지통" }));
  await waitFor(() => expect(gateway.listEncryptedVaultItems).toHaveBeenLastCalledWith({ kind: null, offset: 0, limit: 80, trashed: true }));
});

it("creates a folder inline and shows a refused name next to it", async () => {
  const create = vi.fn()
    .mockRejectedValueOnce({ code: "duplicate_encrypted_vault_folder_name", message: "같은 위치에 같은 이름의 폴더가 있습니다" })
    .mockResolvedValueOnce(folders[0]);
  const gateway = vaultGateway({ createEncryptedVaultFolder: create });
  renderVault(gateway);
  await screen.findByRole("tree", { name: "폴더" });
  await userEvent.click(screen.getByRole("button", { name: "새 폴더" }));
  await userEvent.type(screen.getByRole("textbox", { name: "폴더 이름" }), "여행{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("같은 이름");
  await userEvent.type(screen.getByRole("textbox", { name: "폴더 이름" }), "2{Enter}");
  await waitFor(() => expect(create).toHaveBeenLastCalledWith("여행2", null));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "폴더 이름" })).not.toBeInTheDocument());
  expect(gateway.listEncryptedVaultFolders).toHaveBeenCalledTimes(2);
});

it("moves selected items to a folder from the toolbar and by dragging onto a folder", async () => {
  const gateway = vaultGateway();
  renderVault(gateway);
  await userEvent.click(await screen.findByRole("button", { name: "b.png" }));
  await userEvent.click(screen.getByRole("button", { name: "폴더로 이동 1개" }));
  const dialog = await screen.findByRole("dialog", { name: "1개를 폴더로 이동" });
  await userEvent.click(within(dialog).getByRole("radio", { name: "바다" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "이동" }));
  await waitFor(() => expect(gateway.moveEncryptedVaultItemsToFolder).toHaveBeenCalledWith(["b"], "sea"));
  expect(await screen.findByText("1개를 '바다' 폴더로 옮겼습니다.")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

  const target = screen.getByRole("treeitem", { name: "여행" });
  const elementFromPoint = vi.fn(() => target);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });
  const handle = screen.getByTestId("drag");
  fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 40, pointerId: 1 });
  await waitFor(() => expect(target).toHaveAttribute("data-drop-state", "valid"));
  fireEvent.pointerUp(handle, { clientX: 40, clientY: 40, pointerId: 1 });
  await waitFor(() => expect(gateway.moveEncryptedVaultItemsToFolder).toHaveBeenLastCalledWith(["a"], "trip"));
  Reflect.deleteProperty(document, "elementFromPoint");
});

it("deletes a folder without children and returns to 전체 when it was open", async () => {
  const gateway = vaultGateway({ listEncryptedVaultFolders: vi.fn().mockResolvedValueOnce(folders).mockResolvedValue([folders[0]]) });
  renderVault(gateway);
  const tree = await screen.findByRole("tree", { name: "폴더" });
  await userEvent.click(within(tree).getByRole("button", { name: "여행 펼치기" }));
  const sea = within(tree).getByRole("treeitem", { name: "바다" });
  await userEvent.click(sea);
  fireEvent.contextMenu(sea);
  await userEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));
  await waitFor(() => expect(gateway.deleteEncryptedVaultFolder).toHaveBeenCalledWith("sea"));
  expect(await screen.findByText("'바다' 폴더를 삭제했습니다. 안의 1개는 상위 폴더로 옮겼습니다.")).toBeInTheDocument();
  await waitFor(() => expect(gateway.listEncryptedVaultItems).toHaveBeenLastCalledWith({ kind: null, offset: 0, limit: 80, folderId: "trip" }));
});

it("keeps the index empty and the gallery unscoped on a build without vault folders", async () => {
  const gateway = vaultGateway({ listEncryptedVaultFolders: undefined, moveEncryptedVaultItemsToFolder: undefined });
  renderVault(gateway);
  await screen.findByRole("button", { name: "a.png" });
  expect(screen.queryByRole("tree", { name: "폴더" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "b.png" }));
  expect(screen.queryByRole("button", { name: /폴더로 이동/ })).not.toBeInTheDocument();
});

it("offers no folder changes in a read-only session", async () => {
  const gateway = vaultGateway();
  renderVault(gateway, { ...unlocked, backupIndex: true });
  await screen.findByRole("tree", { name: "폴더" });
  expect(screen.getByRole("button", { name: "새 폴더" })).toBeDisabled();
  expect(screen.queryByTestId("drag")).not.toBeInTheDocument();
});
