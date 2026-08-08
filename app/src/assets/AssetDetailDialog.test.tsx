import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, ClassificationEntry, LibraryGateway } from "../library/types";
import { AssetDetailDialog } from "./AssetDetailDialog";

const asset: AssetSummary = { id: "asset", title: "Asset", originalName: "asset.png", byteSize: 1, width: 400, height: 300, collectedAt: "2026-07-30T00:00:00Z", favorite: true, sourceUrl: "https://example.com/source" };
const classifications: ClassificationEntry[] = [{ id: "tag", kind: "tag", name: "Tag", parentId: null }];
beforeEach(() => Object.defineProperties(HTMLDialogElement.prototype, { showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } }, close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } } }));
afterEach(cleanup);

it("shows asset metadata and saves direct classifications", async () => {
  const user = userEvent.setup(); const gateway = createGateway();
  render(<LibraryProvider gateway={gateway}><AssetDetailDialog asset={asset} classifications={classifications} onClose={vi.fn()} /></LibraryProvider>);
  expect(await screen.findByText("https://example.com/source")).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Tag" }));
  await user.click(screen.getByRole("button", { name: "분류 저장" }));
  await waitFor(() => expect(gateway.setAssetClassifications).toHaveBeenCalledWith("asset", ["tag"]));
});

it("ignores a stale classification response", async () => {
  let resolve!: (ids: string[]) => void; const pending = new Promise<string[]>((done) => { resolve = done; }); const gateway = createGateway();
  vi.mocked(gateway.getAssetClassifications).mockReturnValueOnce(pending).mockResolvedValueOnce(["tag"]);
  const { rerender } = render(<LibraryProvider gateway={gateway}><AssetDetailDialog asset={asset} classifications={classifications} onClose={vi.fn()} /></LibraryProvider>);
  rerender(<LibraryProvider gateway={gateway}><AssetDetailDialog asset={{ ...asset, id: "other" }} classifications={classifications} onClose={vi.fn()} /></LibraryProvider>);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Tag" })).toBeChecked());
  resolve([]); await pending;
  expect(screen.getByRole("checkbox", { name: "Tag" })).toBeChecked();
});

it("moves the open asset to trash", async () => {
  const user = userEvent.setup(); const gateway = createGateway(); const onClose = vi.fn();
  render(<LibraryProvider gateway={gateway}><AssetDetailDialog asset={asset} classifications={classifications} onClose={onClose} /></LibraryProvider>);

  await user.click(await screen.findByRole("button", { name: "휴지통으로 이동" }));

  expect(gateway.trashAsset).toHaveBeenCalledWith("asset");
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("keeps the detail open when moving the asset to trash fails", async () => {
  const user = userEvent.setup(); const gateway = createGateway();
  vi.mocked(gateway.trashAsset).mockRejectedValue(new Error("trash failed"));
  render(<LibraryProvider gateway={gateway}><AssetDetailDialog asset={asset} classifications={classifications} onClose={vi.fn()} /></LibraryProvider>);

  await user.click(await screen.findByRole("button", { name: "휴지통으로 이동" }));

  expect(await screen.findByText("trash failed")).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Asset" })).toBeInTheDocument();
});

function createGateway(): LibraryGateway { return { openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(), createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), deleteClassification: vi.fn(), listAssets: vi.fn(), trashAsset: vi.fn(), trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(), listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(), ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(), restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(), setAssetClassifications: vi.fn().mockResolvedValue(undefined), patchAssetClassifications: vi.fn(), getAssetClassifications: vi.fn().mockResolvedValue([]), ingestImage: vi.fn() }; }
