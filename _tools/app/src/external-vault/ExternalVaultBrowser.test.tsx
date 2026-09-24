import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open } from "@tauri-apps/plugin-dialog";
import type { EncryptedVaultItemPage, EncryptedVaultStatus, LibraryGateway } from "../library/types";
import { ExternalVaultBrowser } from "./ExternalVaultBrowser";
import { resetVaultExportJob } from "./vaultExportJob";
import { resetVaultImportJob } from "./vaultImportJob";

vi.mock("../assets/AssetGallery", () => ({
  AssetGallery: ({ items, onOpen, onSelectionGesture, onDeleteSelection, selectedAssetIds, metadataVisible, mediaSource }: any) => <div aria-label="vault gallery" data-metadata-visible={metadataVisible} data-media-source={mediaSource}>
    {items.map((item: any) => <button key={item.id} data-asset-id={item.id} data-selected={String(Boolean(selectedAssetIds?.has(item.id)))}
      onClick={(event) => onSelectionGesture?.(item, { toggle: event.ctrlKey, range: event.shiftKey })} onDoubleClick={() => onOpen?.(item)}>{item.title || item.originalName}</button>)}
    <button onClick={() => onDeleteSelection?.()}>delete key</button>
  </div>,
}));
vi.mock("../assets/AssetViewer", () => ({
  AssetViewer: ({ items, activeId, onClose, mediaSource, onAssetOpened, onTrash, onExport }: any) => activeId ? <div aria-label="vault viewer" data-media-source={mediaSource} data-records={String(Boolean(onAssetOpened))} data-active={activeId}>
    <button onClick={onClose}>close</button>
    {onTrash && <button onClick={() => onTrash(items.find((item: any) => item.id === activeId))}>viewer trash</button>}
    {onExport && <button onClick={() => onExport(items.find((item: any) => item.id === activeId))}>viewer export</button>}
  </div> : null,
}));

beforeEach(() => vi.mocked(open).mockReset());
afterEach(() => { cleanup(); resetVaultImportJob(); resetVaultExportJob(); vi.useRealTimers(); });

const unlocked: EncryptedVaultStatus = { state: "unlocked", vaultId: "v", root: "/media/usb", itemCount: 2, remembered: true };
const locked: EncryptedVaultStatus = { ...unlocked, state: "locked", itemCount: null, remembered: false };

const page: EncryptedVaultItemPage = {
  items: [
    { id: "a", kind: "image", byteSize: 12, width: 800, height: 600, title: null, originalFileName: "secret.png", importedAt: "2026-09-24T00:00:00Z", hasThumbnail: true },
    { id: "v", kind: "video", byteSize: 24, width: null, height: null, title: "내 영상", originalFileName: "clip.mp4", importedAt: "2026-09-24T00:00:00Z", hasThumbnail: false },
  ],
  totalCount: 2, nextOffset: null,
};

function vaultGateway() {
  return {
    listEncryptedVaultItems: vi.fn().mockResolvedValue(page),
    setEncryptedVaultTitle: vi.fn().mockResolvedValue(undefined),
    unlockEncryptedVault: vi.fn().mockResolvedValue(unlocked),
    lockEncryptedVault: vi.fn().mockResolvedValue(locked),
    importIntoEncryptedVault: vi.fn(),
    importFilesIntoEncryptedVault: vi.fn(),
    trashEncryptedVaultItems: vi.fn().mockImplementation((ids: string[]) => Promise.resolve(ids.length)),
    restoreEncryptedVaultItems: vi.fn().mockImplementation((ids: string[]) => Promise.resolve(ids.length)),
    deleteEncryptedVaultItems: vi.fn().mockImplementation((ids: string[]) => Promise.resolve(ids.length)),
    emptyEncryptedVaultTrash: vi.fn().mockResolvedValue(2),
    exportEncryptedVaultItems: vi.fn(),
    recordAssetOpened: vi.fn(),
    recordAssetsExposed: vi.fn(),
  } as unknown as LibraryGateway;
}

it("opens images and videos in the vault viewer without recording library activity", async () => {
  const gateway = vaultGateway();
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);

  expect(await screen.findByRole("button", { name: "secret.png" })).toBeInTheDocument();
  expect(gateway.listEncryptedVaultItems).toHaveBeenCalledWith({ kind: null, offset: 0, limit: 80 });
  expect(screen.getByLabelText("vault gallery")).toHaveAttribute("data-media-source", "vault");
  fireEvent.doubleClick(screen.getByRole("button", { name: "내 영상" }));
  const viewer = screen.getByLabelText("vault viewer");
  expect(viewer).toHaveAttribute("data-media-source", "vault");
  expect(viewer).toHaveAttribute("data-records", "false");
  expect(gateway.recordAssetOpened).not.toHaveBeenCalled();
  expect(gateway.recordAssetsExposed).not.toHaveBeenCalled();
});

it("filters by kind and hides captions in privacy mode", async () => {
  const gateway = vaultGateway();
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} privacyMode />);
  expect(await screen.findByLabelText("vault gallery")).toHaveAttribute("data-metadata-visible", "false");
  await userEvent.click(screen.getByRole("button", { name: "영상" }));
  await waitFor(() => expect(gateway.listEncryptedVaultItems).toHaveBeenLastCalledWith({ kind: "video", offset: 0, limit: 80 }));
});

it("renames the selected item", async () => {
  const gateway = vaultGateway();
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "secret.png" }));
  await userEvent.click(screen.getByRole("button", { name: "제목 변경" }));
  await userEvent.type(screen.getByLabelText("제목"), "내 제목");
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(gateway.setEncryptedVaultTitle).toHaveBeenCalledWith("a", "내 제목"));
});

it("imports a folder with progress and shows the summary", async () => {
  const gateway = vaultGateway();
  let finish!: (value: unknown) => void;
  let report!: (progress: unknown) => void;
  vi.mocked(gateway.importIntoEncryptedVault!).mockImplementation((_folder, onProgress) => {
    report = onProgress as (progress: unknown) => void;
    return new Promise((resolve) => { finish = resolve; }) as never;
  });
  vi.mocked(open).mockResolvedValue("/home/me/old-vault");
  const onContentChanged = vi.fn();
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} onContentChanged={onContentChanged} />);

  await userEvent.click(await screen.findByRole("button", { name: "가져오기" }));
  await waitFor(() => expect(gateway.importIntoEncryptedVault).toHaveBeenCalledWith("/home/me/old-vault", expect.any(Function)));
  report({ processed: 3, total: 10, imported: 3, skipped: 0, failed: 0 });
  expect(await screen.findByText("가져오는 중 3 / 10")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "잠그기" })).toBeDisabled();

  finish({ total: 10, imported: 8, skipped: 1, failed: 1, withoutThumbnail: 0, legacyTitles: 2, legacyThumbnails: 0, sidecarThumbnails: 3, sidecarSkipped: 2 });
  const dialog = await screen.findByRole("dialog", { name: "가져오기 완료" });
  expect(dialog).toHaveTextContent("가져옴8개");
  expect(dialog).toHaveTextContent("영상 썸네일로 적용3개");
  expect(dialog).toHaveTextContent("이전 보관함 제목2개");
  expect(dialog).not.toHaveTextContent("이전 보관함 썸네일");
  expect(dialog).toHaveTextContent("이미 있음 (같은 내용 확인)1개");
  expect(dialog).toHaveTextContent("원본을 지우기 전에 보관함에서 파일이 열리는지 확인하세요.");
  expect(dialog).toHaveTextContent("실패한 파일은 보관함에 없습니다. 이 파일의 원본은 지우지 마세요.");
  expect(dialog).not.toHaveTextContent("필요 없으면 직접 지우세요");
  expect(dialog).toHaveTextContent("영상 썸네일 파일 건너뜀 (이미 썸네일 있음)2개");
  expect(onContentChanged).toHaveBeenCalled();
  expect(gateway.listEncryptedVaultItems).toHaveBeenCalledTimes(2);
});

it("locks from the toolbar", async () => {
  const gateway = vaultGateway();
  const onStatusChange = vi.fn();
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={onStatusChange} />);
  await userEvent.click(await screen.findByRole("button", { name: "잠그기" }));
  await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(locked));
});

it("unlocks with a password, remembering by default, and explains a wrong password", async () => {
  const gateway = vaultGateway();
  vi.mocked(gateway.unlockEncryptedVault!)
    .mockRejectedValueOnce({ code: "encrypted_vault_wrong_secret", message: "비밀번호 또는 복구 키가 맞지 않습니다" })
    .mockResolvedValueOnce(unlocked);
  const onStatusChange = vi.fn();
  render(<ExternalVaultBrowser gateway={gateway} status={locked} onStatusChange={onStatusChange} />);

  expect(gateway.listEncryptedVaultItems).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "이 PC에서 기억" })).toBeChecked();
  await userEvent.type(screen.getByLabelText("비밀번호"), "wrong");
  await userEvent.click(screen.getByRole("button", { name: "열기" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("비밀번호가 맞지 않습니다.");
  expect(screen.getByLabelText("비밀번호")).toHaveValue("wrong");

  await userEvent.clear(screen.getByLabelText("비밀번호"));
  await userEvent.type(screen.getByLabelText("비밀번호"), "right");
  await userEvent.click(screen.getByRole("button", { name: "열기" }));
  await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(unlocked));
  expect(gateway.unlockEncryptedVault).toHaveBeenLastCalledWith({ kind: "password", value: "right" }, true);
});

it("can unlock with the recovery key instead", async () => {
  const gateway = vaultGateway();
  render(<ExternalVaultBrowser gateway={gateway} status={locked} onStatusChange={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "복구키로 열기" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "이 PC에서 기억" }));
  await userEvent.type(screen.getByLabelText("복구키"), ` ${"a".repeat(64)} `);
  await userEvent.click(screen.getByRole("button", { name: "열기" }));
  await waitFor(() => expect(gateway.unlockEncryptedVault).toHaveBeenCalledWith({ kind: "recoveryKey", value: "a".repeat(64) }, false));
});

it("keeps import progress and the summary when the view is left and reopened", async () => {
  const gateway = vaultGateway();
  let finish!: (value: unknown) => void;
  let report!: (progress: unknown) => void;
  vi.mocked(gateway.importIntoEncryptedVault!).mockImplementation((_folder, onProgress) => {
    report = onProgress as (progress: unknown) => void;
    return new Promise((resolve) => { finish = resolve; }) as never;
  });
  vi.mocked(open).mockResolvedValue("/home/me/photos");
  const first = render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);
  await userEvent.click(await first.findByRole("button", { name: "가져오기" }));
  await waitFor(() => expect(gateway.importIntoEncryptedVault).toHaveBeenCalled());
  first.unmount();

  report({ processed: 4, total: 10, imported: 4, skipped: 0, failed: 0 });
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);
  expect(await screen.findByText("가져오는 중 4 / 10")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "가져오는 중…" })).toBeDisabled();

  finish({ total: 10, imported: 9, skipped: 1, failed: 0, withoutThumbnail: 0, legacyTitles: 0, legacyThumbnails: 0 });
  expect(await screen.findByRole("dialog", { name: "가져오기 완료" })).toHaveTextContent("가져옴9개");
});

it("shows an import that is already running in the backend instead of starting another", async () => {
  const gateway = vaultGateway();
  const running = { id: 3, running: true, progress: { processed: 2, total: 5, imported: 2, skipped: 0, failed: 0 }, report: null, error: null };
  const done = { ...running, running: false, progress: { ...running.progress, processed: 5, imported: 5 },
    report: { total: 5, imported: 5, skipped: 0, failed: 0, withoutThumbnail: 0, legacyTitles: 0, legacyThumbnails: 0 } };
  const getEncryptedVaultImportStatus = vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done);
  Object.assign(gateway, { getEncryptedVaultImportStatus });
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);

  await userEvent.click(await screen.findByRole("button", { name: "가져오기" }));
  expect(await screen.findByText("가져오는 중 2 / 5")).toBeInTheDocument();
  expect(open).not.toHaveBeenCalled();
  expect(gateway.importIntoEncryptedVault).not.toHaveBeenCalled();

  expect(await screen.findByRole("dialog", { name: "가져오기 완료" }, { timeout: 3000 })).toHaveTextContent("가져옴5개");
  expect(gateway.listEncryptedVaultItems).toHaveBeenCalledTimes(2);
});

it("reports an import stopped by a lock and lets it be dismissed", async () => {
  const gateway = vaultGateway();
  vi.mocked(gateway.importIntoEncryptedVault!).mockRejectedValue({ code: "encrypted_vault_locked", message: "locked" });
  vi.mocked(open).mockResolvedValue("/home/me/photos");
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "가져오기" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("비밀 보관함이 잠겨 가져오기를 멈췄습니다. 다시 가져오면 이어서 진행합니다.");
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

const withTrash: EncryptedVaultStatus = { ...unlocked, trashedCount: 2, backupIndex: false };

it("selects several items and moves them to the vault trash, with undo", async () => {
  const gateway = vaultGateway();
  const onContentChanged = vi.fn();
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} onContentChanged={onContentChanged} />);
  const first = await screen.findByRole("button", { name: "secret.png" });
  expect(screen.queryByRole("button", { name: "휴지통으로" })).not.toBeInTheDocument();
  await userEvent.click(first);
  fireEvent.click(screen.getByRole("button", { name: "내 영상" }), { ctrlKey: true });
  expect(screen.getByRole("button", { name: "내 영상" })).toHaveAttribute("data-selected", "true");
  expect(screen.getByRole("button", { name: "제목 변경" })).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "휴지통으로" }));
  await waitFor(() => expect(gateway.trashEncryptedVaultItems).toHaveBeenCalledWith(["a", "v"]));
  await waitFor(() => expect(screen.queryByRole("button", { name: "secret.png" })).not.toBeInTheDocument());
  expect(onContentChanged).toHaveBeenCalled();
  expect(await screen.findByText("2개를 휴지통으로 옮겼습니다.")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "실행 취소" }));
  await waitFor(() => expect(gateway.restoreEncryptedVaultItems).toHaveBeenCalledWith(["a", "v"]));
  expect(await screen.findByRole("button", { name: "secret.png" })).toBeInTheDocument();
});

it("exports the selection or the viewed item to a chosen PC folder with progress", async () => {
  const gateway = vaultGateway();
  let report!: (progress: unknown) => void;
  let finish!: (value: unknown) => void;
  vi.mocked(gateway.exportEncryptedVaultItems!).mockImplementation((_ids, _folder, onProgress) => {
    report = onProgress as (progress: unknown) => void;
    return new Promise((resolve) => { finish = resolve; }) as never;
  });
  vi.mocked(open).mockResolvedValue("/home/me/exported");
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "secret.png" }));
  await userEvent.click(screen.getByRole("button", { name: "내보내기 1개" }));
  await waitFor(() => expect(gateway.exportEncryptedVaultItems).toHaveBeenCalledWith(["a"], "/home/me/exported", expect.any(Function)));
  expect(vi.mocked(open).mock.calls[0]![0]).toMatchObject({ directory: true });
  report({ processed: 0, total: 1, exported: 0, failed: 0 });
  expect(await screen.findByText("내보내는 중 0 / 1")).toBeInTheDocument();
  finish({ processed: 1, total: 1, exported: 1, failed: 0 });
  expect(await screen.findByText("내보내기 완료 · 내보냄 1개")).toBeInTheDocument();

  vi.mocked(gateway.exportEncryptedVaultItems!).mockResolvedValue({ processed: 1, total: 1, exported: 1, failed: 0 });
  fireEvent.doubleClick(screen.getByRole("button", { name: "내 영상" }));
  await userEvent.click(screen.getByRole("button", { name: "viewer export" }));
  await waitFor(() => expect(gateway.exportEncryptedVaultItems).toHaveBeenLastCalledWith(["v"], "/home/me/exported", expect.any(Function)));
});

it("explains an export refused inside the vault USB", async () => {
  const gateway = vaultGateway();
  vi.mocked(gateway.exportEncryptedVaultItems!).mockRejectedValue({ code: "encrypted_vault_invalid_root", message: "x" });
  vi.mocked(open).mockResolvedValue("/media/usb/photos");
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "secret.png" }));
  await userEvent.click(screen.getByRole("button", { name: "내보내기 1개" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("비밀 보관함 USB 안으로는 내보낼 수 없습니다.");
});

it("moves the viewed item to the trash and shows the next one", async () => {
  const gateway = vaultGateway();
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);
  fireEvent.doubleClick(await screen.findByRole("button", { name: "secret.png" }));
  await userEvent.click(screen.getByRole("button", { name: "viewer trash" }));
  await waitFor(() => expect(gateway.trashEncryptedVaultItems).toHaveBeenCalledWith(["a"]));
  await waitFor(() => expect(screen.getByLabelText("vault viewer")).toHaveAttribute("data-active", "v"));
});

it("adds individually chosen files through the import job", async () => {
  const gateway = vaultGateway();
  vi.mocked(gateway.importFilesIntoEncryptedVault!).mockResolvedValue({ total: 2, imported: 2, skipped: 0, failed: 0, withoutThumbnail: 0, legacyTitles: 0, legacyThumbnails: 0 });
  vi.mocked(open).mockResolvedValue(["/home/me/a.png", "/home/me/b.mp4"] as never);
  render(<ExternalVaultBrowser gateway={gateway} status={unlocked} onStatusChange={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "파일 추가" }));
  await waitFor(() => expect(gateway.importFilesIntoEncryptedVault).toHaveBeenCalledWith(["/home/me/a.png", "/home/me/b.mp4"], expect.any(Function)));
  expect(vi.mocked(open).mock.calls[0]![0]).toMatchObject({ directory: false, multiple: true });
  expect(await screen.findByRole("dialog", { name: "가져오기 완료" })).toHaveTextContent("가져옴2개");
});

it("shows the trash with restore, and confirms permanent deletion inside the page", async () => {
  const gateway = vaultGateway();
  const confirmSpy = vi.spyOn(window, "confirm");
  const onContentChanged = vi.fn();
  render(<ExternalVaultBrowser gateway={gateway} status={withTrash} onStatusChange={vi.fn()} onContentChanged={onContentChanged} />);
  await userEvent.click(await screen.findByRole("button", { name: "휴지통 2" }));
  await waitFor(() => expect(gateway.listEncryptedVaultItems).toHaveBeenLastCalledWith({ kind: null, offset: 0, limit: 80, trashed: true }));
  expect(screen.queryByRole("button", { name: "파일 추가" })).not.toBeInTheDocument();

  await userEvent.click(await screen.findByRole("button", { name: "secret.png" }));
  await userEvent.click(screen.getByRole("button", { name: "복원 1개" }));
  await waitFor(() => expect(gateway.restoreEncryptedVaultItems).toHaveBeenCalledWith(["a"]));
  await waitFor(() => expect(screen.queryByRole("button", { name: "secret.png" })).not.toBeInTheDocument());

  await userEvent.click(screen.getByRole("button", { name: "내 영상" }));
  await userEvent.click(screen.getByRole("button", { name: "영구 삭제 1개" }));
  const dialog = await screen.findByRole("dialog", { name: "영구 삭제" });
  expect(dialog).toHaveTextContent("선택한 1개를 USB에서 영구 삭제합니다. 되돌릴 수 없습니다.");
  expect(gateway.deleteEncryptedVaultItems).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole("button", { name: "영구 삭제" }));
  await waitFor(() => expect(gateway.deleteEncryptedVaultItems).toHaveBeenCalledWith(["v"]));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

  await userEvent.click(screen.getByRole("button", { name: "휴지통 비우기" }));
  const empty = await screen.findByRole("dialog", { name: "휴지통 비우기" });
  expect(empty).toHaveTextContent("휴지통의 2개를 USB에서 영구 삭제합니다.");
  await userEvent.click(within(empty).getByRole("button", { name: "취소" }));
  expect(gateway.emptyEncryptedVaultTrash).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "휴지통 비우기" }));
  await userEvent.click(within(await screen.findByRole("dialog", { name: "휴지통 비우기" })).getByRole("button", { name: "영구 삭제" }));
  await waitFor(() => expect(gateway.emptyEncryptedVaultTrash).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("2개를 영구 삭제했습니다.")).toBeInTheDocument();
  expect(onContentChanged).toHaveBeenCalled();
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it("offers only restore when the vault opened from its backup index", async () => {
  const gateway = vaultGateway();
  render(<ExternalVaultBrowser gateway={gateway} status={{ ...withTrash, backupIndex: true }} onStatusChange={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "휴지통 2" }));
  await userEvent.click(await screen.findByRole("button", { name: "secret.png" }));
  expect(screen.getByRole("button", { name: "영구 삭제 1개" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "휴지통 비우기" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "복원 1개" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "delete key" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText(/백업본으로 열었습니다/)).toBeInTheDocument();
});
