import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open } from "@tauri-apps/plugin-dialog";

beforeEach(() => {
  vi.mocked(open).mockReset();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:frame") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
import type { LibraryGateway, PrivateVaultAssetPage } from "../library/types";
import { ExternalVaultBrowser } from "./ExternalVaultBrowser";

vi.mock("../assets/AssetGallery", () => ({
  AssetGallery: ({ items, onOpen, onSelectionGesture, metadataVisible }: any) => <div aria-label="vault gallery" data-metadata-visible={metadataVisible}>
    {items.map((item: any) => <button key={item.id} onClick={() => onSelectionGesture?.(item, {})} onDoubleClick={() => onOpen?.(item)}>{item.title || item.originalName}</button>)}
  </div>,
}));
vi.mock("../assets/AssetViewer", () => ({
  AssetViewer: ({ activeId, onClose }: any) => activeId ? <div aria-label="vault viewer"><button onClick={onClose}>close</button></div> : null,
}));

it("loads portable assets without recording normal library activity", async () => {
  const page: PrivateVaultAssetPage = {
    items: [{ id: "a", title: null, originalName: "secret.png", byteSize: 12, width: 800, height: 600,
      modifiedAt: "2026-09-13T00:00:00Z", media: { kind: "image" } }],
    totalCount: 1, nextOffset: null,
  };
  const gateway = vaultGateway(page);
  render(<ExternalVaultBrowser gateway={gateway} />);

  expect(await screen.findByRole("button", { name: "secret.png" })).toBeInTheDocument();
  expect(gateway.listPrivateVaultAssets).toHaveBeenCalledWith({ mediaKind: null, offset: 0, limit: 80 });
  fireEvent.doubleClick(screen.getByRole("button", { name: "secret.png" }));
  expect(screen.getByLabelText("vault viewer")).toBeInTheDocument();
  expect(gateway.recordAssetOpened).not.toHaveBeenCalled();
  expect(gateway.recordAssetsExposed).not.toHaveBeenCalled();
});

it("opens vault videos with the isolated native player", async () => {
  const page: PrivateVaultAssetPage = {
    items: [{ id: "v", title: null, originalName: "secret.mp4", byteSize: 24, width: 1920, height: 1080,
      modifiedAt: "2026-09-13T00:00:00Z", media: { kind: "video", durationMs: 1_000, preparationState: "ready", scrubFrameCount: 0 } }],
    totalCount: 1, nextOffset: null,
  };
  const gateway = vaultGateway(page);
  render(<ExternalVaultBrowser gateway={gateway} />);

  fireEvent.doubleClick(await screen.findByRole("button", { name: "secret.mp4" }));

  await waitFor(() => expect(gateway.playPrivateVaultVideo).toHaveBeenCalledWith("v"));
  expect(screen.queryByLabelText("vault viewer")).not.toBeInTheDocument();
});

it("shows the actionable native player error", async () => {
  const page: PrivateVaultAssetPage = {
    items: [{ id: "v", title: null, originalName: "secret.mp4", byteSize: 24, width: 1920, height: 1080,
      modifiedAt: "2026-09-13T00:00:00Z", media: { kind: "video", durationMs: 1_000, preparationState: "ready", scrubFrameCount: 0 } }],
    totalCount: 1, nextOffset: null,
  };
  const gateway = vaultGateway(page);
  vi.mocked(gateway.playPrivateVaultVideo!).mockRejectedValue({
    code: "media_player_unavailable",
    message: "비밀 영상 재생을 위해 mpv를 설치해 주세요",
  });
  render(<ExternalVaultBrowser gateway={gateway} />);

  fireEvent.doubleClick(await screen.findByRole("button", { name: "secret.mp4" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("비밀 영상 재생을 위해 mpv를 설치해 주세요");
});

it("shows custom title captions and video editing controls after selection", async () => {
  const page: PrivateVaultAssetPage = {
    items: [{ id: "v", title: "내 제목", originalName: "secret.mp4", byteSize: 24, width: 1920, height: 1080,
      modifiedAt: "2026-09-13T00:00:00Z", media: { kind: "video", durationMs: 1_000, preparationState: "ready", scrubFrameCount: 0 } }],
    totalCount: 1, nextOffset: null,
  };
  const gateway = vaultGateway(page);
  render(<ExternalVaultBrowser gateway={gateway} />);

  const card = await screen.findByRole("button", { name: "내 제목" });
  expect(screen.getByLabelText("vault gallery")).toHaveAttribute("data-metadata-visible", "true");
  fireEvent.click(card);

  expect(screen.getByRole("button", { name: "제목 변경" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "썸네일 변경" })).toBeEnabled();
});

it("saves a custom video title", async () => {
  const page: PrivateVaultAssetPage = {
    items: [{ id: "v", title: null, originalName: "secret.mp4", byteSize: 24, width: 1920, height: 1080,
      modifiedAt: "2026-09-13T00:00:00Z", media: { kind: "video", durationMs: 70_000, preparationState: "ready", scrubFrameCount: 0 } }],
    totalCount: 1, nextOffset: null,
  };
  const gateway = vaultGateway(page);
  render(<ExternalVaultBrowser gateway={gateway} />);

  fireEvent.click(await screen.findByRole("button", { name: "secret.mp4" }));
  fireEvent.click(screen.getByRole("button", { name: "제목 변경" }));
  fireEvent.change(screen.getByRole("textbox", { name: "제목" }), { target: { value: "내 제목" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await waitFor(() => expect(gateway.setPrivateVaultTitle).toHaveBeenCalledWith("v", "내 제목"));
});

it("sets a thumbnail from a chosen image file", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/cover.png");
  const page: PrivateVaultAssetPage = {
    items: [{ id: "v", title: null, originalName: "secret.mp4", byteSize: 24, width: 1920, height: 1080,
      modifiedAt: "2026-09-13T00:00:00Z", media: { kind: "video", durationMs: 70_000, preparationState: "ready", scrubFrameCount: 0 } }],
    totalCount: 1, nextOffset: null,
  };
  const gateway = vaultGateway(page);
  render(<ExternalVaultBrowser gateway={gateway} />);

  fireEvent.click(await screen.findByRole("button", { name: "secret.mp4" }));
  fireEvent.click(screen.getByRole("button", { name: "썸네일 변경" }));
  fireEvent.click(screen.getByRole("button", { name: "이미지 파일 선택" }));

  await waitFor(() => expect(gateway.setPrivateVaultThumbnailFromFile).toHaveBeenCalledWith("v", "/tmp/cover.png"));
});

it("chooses one of the generated video frames as the thumbnail", async () => {
  const page: PrivateVaultAssetPage = {
    items: [{ id: "v", title: null, originalName: "secret.mp4", byteSize: 24, width: 1920, height: 1080,
      modifiedAt: "2026-09-13T00:00:00Z", media: { kind: "video", durationMs: 70_000, preparationState: "ready", scrubFrameCount: 0 } }],
    totalCount: 1, nextOffset: null,
  };
  const gateway = vaultGateway(page);
  vi.mocked(gateway.listPrivateVaultThumbnailCandidates!).mockResolvedValue([{ timestampMs: 10_000, imageBytes: [82, 73, 70, 70] }]);
  render(<ExternalVaultBrowser gateway={gateway} />);

  fireEvent.click(await screen.findByRole("button", { name: "secret.mp4" }));
  fireEvent.click(screen.getByRole("button", { name: "썸네일 변경" }));
  fireEvent.click(screen.getByRole("button", { name: "영상에서 고르기" }));
  const frame = await screen.findByRole("img", { name: "0:10 프레임" });
  fireEvent.click(frame.closest("button")!);

  await waitFor(() => expect(gateway.setPrivateVaultThumbnailFromFrame).toHaveBeenCalledWith("v", 10_000));
});

it("automatically reconciles external file changes while the vault is open", async () => {
  vi.useFakeTimers();
  const first: PrivateVaultAssetPage = {
    items: [{ id: "v", title: null, originalName: "secret.mp4", byteSize: 24, width: 1920, height: 1080,
      modifiedAt: "2026-09-13T00:00:00Z", media: { kind: "video", durationMs: 1_000, preparationState: "ready", scrubFrameCount: 0 } }],
    totalCount: 1, nextOffset: null,
  };
  const empty: PrivateVaultAssetPage = { items: [], totalCount: 0, nextOffset: null };
  const gateway = vaultGateway(first);
  vi.mocked(gateway.listPrivateVaultAssets!).mockResolvedValueOnce(first).mockResolvedValue(empty);
  vi.mocked(gateway.scanPrivateVault!).mockResolvedValueOnce({ scanned: 0, added: 0, updated: 0, unchanged: 0, removed: 1, failed: 0 });
  render(<ExternalVaultBrowser gateway={gateway} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "secret.mp4" })).toBeInTheDocument();

  await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); await Promise.resolve(); });

  expect(gateway.scanPrivateVault).toHaveBeenCalled();
  expect(gateway.listPrivateVaultAssets).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "secret.mp4" })).not.toBeInTheDocument();
  vi.useRealTimers();
});

it("refreshes the index and reloads the first page", async () => {
  const page: PrivateVaultAssetPage = { items: [], totalCount: 0, nextOffset: null };
  const gateway = vaultGateway(page);
  render(<ExternalVaultBrowser gateway={gateway} />);
  await waitFor(() => expect(gateway.listPrivateVaultAssets).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
  await waitFor(() => expect(gateway.scanPrivateVault).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(gateway.listPrivateVaultAssets).toHaveBeenCalledTimes(2));
});
function vaultGateway(page: PrivateVaultAssetPage) {
  return {
    listPrivateVaultAssets: vi.fn().mockResolvedValue(page),
    scanPrivateVault: vi.fn().mockResolvedValue({ scanned: 0, added: 0, updated: 0, unchanged: 0, removed: 0, failed: 0 }),
    playPrivateVaultVideo: vi.fn().mockResolvedValue(undefined),
    setPrivateVaultTitle: vi.fn().mockResolvedValue(undefined),
    listPrivateVaultThumbnailCandidates: vi.fn().mockResolvedValue([]),
    setPrivateVaultThumbnailFromFile: vi.fn().mockResolvedValue(undefined),
    setPrivateVaultThumbnailFromFrame: vi.fn().mockResolvedValue(undefined),
    resetPrivateVaultThumbnail: vi.fn().mockResolvedValue(undefined),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined),
    recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
  } as unknown as LibraryGateway;
}
