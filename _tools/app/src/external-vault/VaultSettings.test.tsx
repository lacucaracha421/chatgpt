import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { LibraryProvider } from "../library/LibraryContext";
import type { EncryptedVaultImportReport, EncryptedVaultStatus, LibraryGateway } from "../library/types";
import { VaultSettings } from "./VaultSettings";
import { resetVaultImportJob, startVaultImport, vaultImportResultText } from "./vaultImportJob";

afterEach(() => { cleanup(); resetVaultImportJob(); localStorage.clear(); });

const unlocked: EncryptedVaultStatus = { state: "unlocked", vaultId: "v", root: "/media/usb", itemCount: 12, remembered: false };
const examples = ["a.mp4_thumb.jpg", "b.mp4_thumb.jpg", "c.mp4_thumb.jpg", "d.mp4_thumb.jpg", "e.mp4_thumb.jpg"];

function gatewayWith(overrides: Partial<LibraryGateway>) {
  return {
    getEncryptedVaultStatus: vi.fn().mockResolvedValue(unlocked),
    previewEncryptedVaultSidecarCleanup: vi.fn().mockResolvedValue({ count: 7, examples }),
    applyEncryptedVaultSidecarCleanup: vi.fn().mockResolvedValue({ movedToVideoThumbnail: 6, removed: 7 }),
    importIntoEncryptedVault: vi.fn(),
    ...overrides,
  } as unknown as LibraryGateway;
}

function renderSettings(gateway: LibraryGateway, onChanged = vi.fn(), onSaved = vi.fn()) {
  render(<LibraryProvider gateway={gateway}><dl><VaultSettings onChanged={onChanged} onSaved={onSaved} /></dl></LibraryProvider>);
  return { onChanged, onSaved };
}

it("hides the sidecar cleanup when there is nothing to clean or the vault is locked", async () => {
  const gateway = gatewayWith({ previewEncryptedVaultSidecarCleanup: vi.fn().mockResolvedValue({ count: 0, examples: [] }) });
  renderSettings(gateway);
  expect(await screen.findByText(/열림 · 12개/)).toBeVisible();
  await waitFor(() => expect(gateway.previewEncryptedVaultSidecarCleanup).toHaveBeenCalled());
  expect(screen.queryByText("영상 썸네일 파일 정리")).not.toBeInTheDocument();
  cleanup();

  const lockedGateway = gatewayWith({ getEncryptedVaultStatus: vi.fn().mockResolvedValue({ ...unlocked, state: "locked", itemCount: null }) });
  renderSettings(lockedGateway);
  expect(await screen.findByText(/잠김/)).toBeVisible();
  expect(lockedGateway.previewEncryptedVaultSidecarCleanup).not.toHaveBeenCalled();
  expect(screen.queryByText("영상 썸네일 파일 정리")).not.toBeInTheDocument();
});

it("confirms with example names, applies the cleanup and reports the result", async () => {
  const preview = vi.fn()
    .mockResolvedValueOnce({ count: 7, examples })
    .mockResolvedValue({ count: 0, examples: [] });
  const gateway = gatewayWith({ previewEncryptedVaultSidecarCleanup: preview });
  const { onChanged, onSaved } = renderSettings(gateway);

  expect(await screen.findByText("영상 썸네일 파일 정리")).toBeVisible();
  expect(screen.getByText("영상 옆에 있던 썸네일 이미지 7개를 해당 영상의 썸네일로 옮기고 목록에서 뺍니다.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "썸네일 파일 정리" }));
  const confirm = screen.getByRole("group", { name: "썸네일 파일 정리 확인" });
  expect(within(confirm).getAllByRole("listitem").map((item) => item.textContent)).toEqual(examples);
  expect(confirm).toHaveTextContent("등 7개");
  expect(gateway.applyEncryptedVaultSidecarCleanup).not.toHaveBeenCalled();

  await userEvent.click(within(confirm).getByRole("button", { name: "취소" }));
  expect(screen.queryByRole("group", { name: "썸네일 파일 정리 확인" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "썸네일 파일 정리" }));
  await userEvent.click(screen.getByRole("button", { name: "정리하기" }));

  await waitFor(() => expect(gateway.applyEncryptedVaultSidecarCleanup).toHaveBeenCalledTimes(1));
  const message = "썸네일 이미지 7개를 목록에서 뺐습니다 · 영상 썸네일로 옮김 6개";
  expect(await screen.findByRole("status")).toHaveTextContent(message);
  expect(onSaved).toHaveBeenCalledWith(message);
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "썸네일 파일 정리" })).not.toBeInTheDocument();
});

it("cannot clean up while a vault import runs", async () => {
  let finish!: (report: EncryptedVaultImportReport) => void;
  const gateway = gatewayWith({
    importIntoEncryptedVault: vi.fn(() => new Promise<EncryptedVaultImportReport>((resolve) => { finish = resolve; })),
  });
  renderSettings(gateway);
  const button = await screen.findByRole("button", { name: "썸네일 파일 정리" });
  expect(button).toBeEnabled();

  act(() => { void startVaultImport(gateway, "/home/me/videos"); });
  await waitFor(() => expect(button).toBeDisabled());
  expect(screen.getByText(/가져오기가 끝난 뒤에 정리할 수 있습니다/)).toBeVisible();

  await act(async () => finish({ total: 3, imported: 1, skipped: 0, failed: 0, withoutThumbnail: 0, legacyTitles: 0, legacyThumbnails: 0, sidecarThumbnails: 2 }));
  await waitFor(() => expect(screen.getByRole("button", { name: "썸네일 파일 정리" })).toBeEnabled());
  expect(gateway.previewEncryptedVaultSidecarCleanup).toHaveBeenCalledTimes(2);
});

it("shows backend refusals from a concurrent import", async () => {
  const gateway = gatewayWith({
    applyEncryptedVaultSidecarCleanup: vi.fn().mockRejectedValue({ code: "encrypted_vault_import_running", message: "running" }),
  });
  renderSettings(gateway);
  await userEvent.click(await screen.findByRole("button", { name: "썸네일 파일 정리" }));
  await userEvent.click(screen.getByRole("button", { name: "정리하기" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("가져오기가 끝난 뒤에 정리할 수 있습니다.");
});

it("mentions applied sidecar thumbnails in the import summary only when there are some", () => {
  const report = { total: 5, imported: 3, skipped: 0, failed: 0, withoutThumbnail: 0, legacyTitles: 0, legacyThumbnails: 0 };
  const job = (sidecarThumbnails: number) => ({ running: false, progress: null, error: null, report: { ...report, sidecarThumbnails } });
  expect(vaultImportResultText(job(2))).toBe("완료 · 가져옴 3개 · 영상 썸네일로 적용 2개");
  expect(vaultImportResultText(job(0))).toBe("완료 · 가져옴 3개");
});
