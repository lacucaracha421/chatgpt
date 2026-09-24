import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open } from "@tauri-apps/plugin-dialog";
import type { EncryptedVaultItemPage, EncryptedVaultStatus, LibraryGateway } from "../library/types";
import { ExternalVaultBrowser } from "./ExternalVaultBrowser";
import { resetVaultImportJob } from "./vaultImportJob";

vi.mock("../assets/AssetGallery", () => ({
  AssetGallery: ({ items, onOpen, onSelectionGesture, metadataVisible, mediaSource }: any) => <div aria-label="vault gallery" data-metadata-visible={metadataVisible} data-media-source={mediaSource}>
    {items.map((item: any) => <button key={item.id} onClick={() => onSelectionGesture?.(item, {})} onDoubleClick={() => onOpen?.(item)}>{item.title || item.originalName}</button>)}
  </div>,
}));
vi.mock("../assets/AssetViewer", () => ({
  AssetViewer: ({ activeId, onClose, mediaSource, onAssetOpened }: any) => activeId ? <div aria-label="vault viewer" data-media-source={mediaSource} data-records={String(Boolean(onAssetOpened))}><button onClick={onClose}>close</button></div> : null,
}));

beforeEach(() => vi.mocked(open).mockReset());
afterEach(() => { cleanup(); resetVaultImportJob(); vi.useRealTimers(); });

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

  finish({ total: 10, imported: 8, skipped: 1, failed: 1, withoutThumbnail: 0, legacyTitles: 2, legacyThumbnails: 0, sidecarThumbnails: 3 });
  const dialog = await screen.findByRole("dialog", { name: "가져오기 완료" });
  expect(dialog).toHaveTextContent("가져옴8개");
  expect(dialog).toHaveTextContent("영상 썸네일로 적용3개");
  expect(dialog).toHaveTextContent("이전 보관함 제목2개");
  expect(dialog).not.toHaveTextContent("이전 보관함 썸네일");
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
