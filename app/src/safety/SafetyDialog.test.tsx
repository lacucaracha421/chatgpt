import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MetadataBackup } from "../library/types";
import { SafetyDialog } from "./SafetyDialog";

const backup: MetadataBackup = {
  id: "backup-1",
  kind: "daily",
  createdAt: "2026-08-01T12:00:00Z",
  byteSize: 2048,
};

describe("SafetyDialog", () => {
  afterEach(cleanup);

  it("lists localized backup metadata and restores with only its opaque id", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listMetadataBackups).mockResolvedValue([
      backup,
      { ...backup, id: "backup-2", kind: "pre_migration" },
      { ...backup, id: "backup-3", kind: "pre_restore" },
    ]);
    const onRestore = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderDialog(gateway, { onRestore });

    expect(await screen.findAllByText("2026. 8. 1.")).toHaveLength(3);
    expect(screen.getByText("자동 백업")).toBeVisible();
    expect(screen.getByText("업데이트 전")).toBeVisible();
    expect(screen.getByText("복구 직전")).toBeVisible();
    expect(screen.getAllByText("2,048 B")).toHaveLength(3);
    const firstBackup = screen.getAllByRole("listitem")[0];
    await user.click(within(firstBackup).getByRole("button", { name: "이 시점으로 복구" }));

    expect(screen.getByText(/현재 상태를 별도로 보존한 뒤/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "복구 시작" }));

    expect(onRestore).toHaveBeenCalledWith("backup-1");
  });

  it("keeps the dialog available when restoring fails", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listMetadataBackups).mockResolvedValue([backup]);
    const onRestore = vi.fn().mockRejectedValue(new Error("복구하지 못했습니다."));
    const user = userEvent.setup();

    renderDialog(gateway, { onRestore });
    await user.click(await screen.findByRole("button", { name: "이 시점으로 복구" }));
    await user.click(screen.getByRole("button", { name: "복구 시작" }));

    expect(await screen.findByText("복구하지 못했습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "복구 시작" })).toBeEnabled();
  });

  it("submits a restore only once while the first request is pending", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listMetadataBackups).mockResolvedValue([backup]);
    const onRestore = vi.fn().mockReturnValue(new Promise<void>(() => undefined));
    const user = userEvent.setup();

    renderDialog(gateway, { onRestore });
    await user.click(await screen.findByRole("button", { name: "이 시점으로 복구" }));
    const restoreButton = screen.getByRole("button", { name: "복구 시작" });
    await user.click(restoreButton);
    await user.click(restoreButton);

    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("offers retry after the backup list fails to load", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listMetadataBackups)
      .mockRejectedValueOnce(new Error("백업 목록 오류"))
      .mockResolvedValueOnce([backup]);
    const user = userEvent.setup();

    renderDialog(gateway);

    await user.click(await screen.findByRole("button", { name: "다시 시도" }));

    await waitFor(() => expect(gateway.listMetadataBackups).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("2026. 8. 1.")).toBeVisible();
  });
});

function renderDialog(
  gateway: LibraryGateway,
  overrides: Partial<React.ComponentProps<typeof SafetyDialog>> = {},
) {
  render(
    <LibraryProvider gateway={gateway}>
      <SafetyDialog
        open
        restoring={false}
        onClose={vi.fn()}
        onRestore={vi.fn().mockResolvedValue(undefined)}
        {...overrides}
      />
    </LibraryProvider>,
  );
}

function createGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(),
    currentLibrary: vi.fn(),
    listClassifications: vi.fn(),
    createClassification: vi.fn(),
    renameClassification: vi.fn(),
    moveClassification: vi.fn(),
    deleteClassification: vi.fn(),
    listAssets: vi.fn(),
    trashAsset: vi.fn(),
    trashAssets: vi.fn(),
    restoreAsset: vi.fn(),
    restoreAssets: vi.fn(),
    listTrash: vi.fn(),
    emptyTrash: vi.fn(),
    getTrashPolicy: vi.fn(),
    setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(),
    listMetadataBackups: vi.fn().mockResolvedValue([]),
    restoreMetadataBackup: vi.fn(),
    purgeExpiredTrash: vi.fn(),
    setAssetFavorite: vi.fn(),
    setAssetsFavorite: vi.fn(),
    setAssetClassifications: vi.fn(),
    patchAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(),
    ingestImage: vi.fn(),
  };
}
