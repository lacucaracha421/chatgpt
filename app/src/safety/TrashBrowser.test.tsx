import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { TrashBrowser } from "./TrashBrowser";

afterEach(cleanup);
beforeEach(() => Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } },
  close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
}));

it("loads trash, shows its purge date, and restores an asset", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  await waitFor(() => expect(gateway.listTrash).toHaveBeenCalledWith({ after: null, limit: 100 }));
  expect(await screen.findByText("영구 삭제까지 12일")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "복원" }));
  expect(gateway.restoreAsset).toHaveBeenCalledWith("asset-1");
});

it("keeps retention controls disabled until the policy is loaded", () => {
  const gateway = createGateway();
  vi.mocked(gateway.getTrashPolicy).mockReturnValue(new Promise(() => undefined));

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).not.toBeChecked();
  expect(screen.queryByRole("spinbutton", { name: "보존 기간" })).not.toBeInTheDocument();
});

it("disables automatic deletion and saves a valid retention period", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  await screen.findByRole("checkbox", { name: "자동 삭제" });
  await user.click(screen.getByRole("checkbox", { name: "자동 삭제" }));
  expect(gateway.setTrashPolicy).toHaveBeenCalledWith({ retentionDays: null });

  await user.click(screen.getByRole("checkbox", { name: "자동 삭제" }));
  const input = screen.getByRole("spinbutton", { name: "보존 기간" });
  await user.clear(input);
  await user.type(input, "45");
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(gateway.setTrashPolicy).toHaveBeenLastCalledWith({ retentionDays: 45 });
});

it("confirms emptying the whole trash using the server totals", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  await screen.findByText("asset-1.png");
  await user.click(screen.getByRole("button", { name: "휴지통 비우기" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("2개 (3 KB)를 영구 삭제합니다.");
  await user.click(screen.getByRole("button", { name: "영구 삭제" }));
  expect(gateway.emptyTrash).toHaveBeenCalledOnce();
});

function createGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), setAssetFavorite: vi.fn(),
    setAssetClassifications: vi.fn(), getAssetClassifications: vi.fn(), ingestImage: vi.fn(),
    trashAsset: vi.fn(), restoreAsset: vi.fn(),
    listTrash: vi.fn().mockResolvedValue({
      items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: new Date(Date.now() + 12 * 86_400_000).toISOString() }],
      nextCursor: null,
      totalCount: 2,
      totalBytes: 3_072,
    }),
    emptyTrash: vi.fn().mockResolvedValue({ deletedCount: 2, failedAssetIds: [] }),
    getTrashPolicy: vi.fn().mockResolvedValue({ retentionDays: 30 }),
    setTrashPolicy: vi.fn().mockResolvedValue(undefined),
  } as unknown as LibraryGateway;
}

function asset() {
  return {
    id: "asset-1", title: null, originalName: "asset-1.png", byteSize: 1_024,
    width: 200, height: 100, collectedAt: "2026-07-20T00:00:00Z", favorite: false, sourceUrl: null,
  };
}
