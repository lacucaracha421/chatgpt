import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeFileDropEvent } from "../../ingestion/useFileDrop";
import type { FavoriteEntry } from "../../library/types";
import { nativeDropClaimed } from "../../ingestion/dropClaims";
import { FavoriteCoverDialog } from "./FavoriteCoverDialog";
import { favoriteTargets } from "./model";

const mocks = vi.hoisted(() => ({ ingestMedia: vi.fn(), stageClipboardImage: vi.fn(), removeClipboardImage: vi.fn(), open: vi.fn(), drop: null as ((event: NativeFileDropEvent) => void) | null }));
vi.mock("../../library/LibraryContext", () => ({ useLibrary: () => ({ gateway: { ingestMedia: mocks.ingestMedia, stageClipboardImage: mocks.stageClipboardImage, removeClipboardImage: mocks.removeClipboardImage } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../../ingestion/useFileDrop", () => ({ subscribeToTauriDrops: async (handler: (event: NativeFileDropEvent) => void) => { mocks.drop = handler; return () => { mocks.drop = null; }; } }));
vi.mock("../../assets/AssetGallery", () => ({ AssetGallery: () => null }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const entry: FavoriteEntry = { characterId: "manual-new", name: "名前", seriesName: "作品", coverAssetId: null, coverY: 50, profile: {}, workIds: [], extraWorks: [] };
const page = { items: [], nextCursor: null, totalCount: 0 };

it.each([false, true])("removes a pasted image's temporary file after import (failure: %s)", async failure => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const image = new File([bytes], "clipboard.png", { type: "image/png" });
  Object.defineProperty(image, "arrayBuffer", { value: async () => bytes.buffer });
  mocks.stageClipboardImage.mockResolvedValue("C:\\cache\\cover-paste.png");
  mocks.removeClipboardImage.mockResolvedValue(undefined);
  if (failure) mocks.ingestMedia.mockRejectedValue(new Error("Import failed"));
  else mocks.ingestMedia.mockResolvedValue({ status: "exact_duplicate", existingAssetId: "pasted", classificationChanged: false });
  const save = vi.fn().mockResolvedValue(true);
  render(<FavoriteCoverDialog target={favoriteTargets([entry], [])[0]} entry={entry} initialPage={page} busy={false} onSave={save} onClose={() => undefined} />);
  fireEvent.paste(screen.getByRole("button", { name: "파일 선택" }), { clipboardData: { items: [
    { kind: "string", type: "text/plain" },
    { kind: "file", type: "image/png", getAsFile: () => image },
    { kind: "file", type: "image/png", getAsFile: () => new File(["ignored"], "second.png") },
  ] } });
  await waitFor(() => expect(mocks.removeClipboardImage).toHaveBeenCalledWith("C:\\cache\\cover-paste.png"));
  expect(mocks.stageClipboardImage).toHaveBeenCalledWith("image/png", Array.from(bytes));
  expect(mocks.ingestMedia).toHaveBeenCalledTimes(1);
  expect(mocks.ingestMedia).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: "C:\\cache\\cover-paste.png" }));
  if (failure) expect(screen.getByRole("alert")).toHaveTextContent("Import failed");
  else {
    fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ coverAssetId: "pasted", coverY: 50 }));
  }
});

it("imports a selected image into unclassified and saves its cover after crop selection", async () => {
  mocks.open.mockResolvedValue("C:\\images\\new.png");
  mocks.ingestMedia.mockResolvedValue({ status: "added", asset: { id: "imported", media: { kind: "image" } } });
  const save = vi.fn().mockResolvedValue(true), close = vi.fn();
  render(<FavoriteCoverDialog target={favoriteTargets([entry], [])[0]} entry={entry} initialPage={page} busy={false} onSave={save} onClose={close} />);
  expect(screen.getByText("名前")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "파일 선택" }));
  await waitFor(() => expect(mocks.ingestMedia).toHaveBeenCalledWith({ sourcePath: "C:\\images\\new.png", classificationId: null, sourceUrl: null, importSource: "direct", importBatchId: expect.any(String) }));
  await waitFor(() => expect(screen.getByRole("button", { name: "바꾸기" })).toBeEnabled());
  expect(screen.getByText("名前")).toBeInTheDocument(); // Keep the name card until the imported thumbnail decodes.
  fireEvent.change(screen.getByRole("slider"), { target: { value: "32" } });
  fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ coverAssetId: "imported", coverY: 32 }));
  expect(close).toHaveBeenCalled();
});

it("claims native drops while open and uses the existing asset for a duplicate file", async () => {
  mocks.ingestMedia.mockResolvedValue({ status: "exact_duplicate", existingAssetId: "existing", classificationChanged: false });
  const box = { left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box);
  const save = vi.fn().mockResolvedValue(true);
  const view = render(<FavoriteCoverDialog target={favoriteTargets([entry], [])[0]} entry={entry} initialPage={page} busy={false} onSave={save} onClose={() => undefined} />);
  await waitFor(() => expect(mocks.drop).not.toBeNull());
  expect(nativeDropClaimed({ x: 20, y: 20 })).toBe(true);
  await act(async () => { mocks.drop?.({ type: "drop", paths: ["C:\\images\\duplicate.png"], position: { x: 20, y: 20 } }); });
  fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ coverAssetId: "existing", coverY: 50 }));
  expect(mocks.ingestMedia).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(nativeDropClaimed({ x: 20, y: 20 })).toBe(false);
});
