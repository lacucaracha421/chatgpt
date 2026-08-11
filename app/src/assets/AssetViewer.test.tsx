import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetViewer } from "./AssetViewer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("uses original media and navigates only inside the loaded order", () => {
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={[asset("a", "a.gif"), asset("b", "b.png")]} activeId="a" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "a.gif" });

  expect(dialog).toHaveClass("ui-dialog--fullscreen");
  expect(screen.getByRole("img", { name: "a.gif" })).toHaveAttribute("src", "http://lakomics.localhost/asset/a");
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  expect(onActiveIdChange).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(onActiveIdChange).toHaveBeenCalledWith("b");
});

it("supports buttons and Escape without wrapping at the final asset", async () => {
  const user = userEvent.setup();
  const onActiveIdChange = vi.fn();
  const onClose = vi.fn();
  render(<AssetViewer items={[asset("a", "a.gif"), asset("b", "b.png")]} activeId="b" onActiveIdChange={onActiveIdChange} onClose={onClose} />);

  expect(screen.getByRole("button", { name: "다음 자산" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(onActiveIdChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "이전 자산" }));
  expect(onActiveIdChange).toHaveBeenCalledWith("a");
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
});

it("toggles favorite and moves to trash from the keyboard and buttons", () => {
  const onToggleFavorite = vi.fn();
  const onTrash = vi.fn();
  render(<AssetViewer items={[asset("a", "a.gif")]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} onToggleFavorite={onToggleFavorite} onTrash={onTrash} />);
  const dialog = screen.getByRole("dialog", { name: "a.gif" });

  fireEvent.keyDown(dialog, { key: "f" });
  expect(onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  fireEvent.keyDown(dialog, { key: "Delete" });
  expect(onTrash).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  fireEvent.click(screen.getByRole("button", { name: "즐겨찾기 켜기" }));
  expect(onToggleFavorite).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "휴지통으로 이동" }));
  expect(onTrash).toHaveBeenCalledTimes(2);
});

it("renders a video player and cleans up its source when navigating", () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  const first = videoAsset("video-a", "a.webm");
  const second = videoAsset("video-b", "b.webm");
  const { rerender } = render(<AssetViewer items={[first, second]} activeId="video-a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  const oldVideo = screen.getByLabelText("a.webm 영상");

  rerender(<AssetViewer items={[first, second]} activeId="video-b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);

  expect(pause).toHaveBeenCalled();
  expect(load).toHaveBeenCalled();
  expect(oldVideo).not.toHaveAttribute("src");
  expect(screen.getByLabelText("b.webm 영상")).toHaveAttribute("src", "http://lakomics.localhost/playback/video-b");
});

function asset(id: string, originalName: string): AssetSummary {
  return { id, title: null, originalName, byteSize: 1, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: null, media: { kind: "image" } };
}

function videoAsset(id: string, originalName: string): AssetSummary {
  return { ...asset(id, originalName), media: { kind: "video", durationMs: 60_000, preparationState: "ready", scrubFrameCount: 6 } };
}
