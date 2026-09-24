import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetViewer, VIEWER_CHROME_IDLE_MS } from "./AssetViewer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

it("labels the dialog with the asset name and shows no top-left name overlay", () => {
  render(<AssetViewer items={[asset("a", "a.gif"), asset("b", "b.png")]} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);

  expect(screen.getByRole("dialog", { name: "b.png" })).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "현재 자산" })).not.toBeInTheDocument();
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

it("hides library management actions when handlers are absent", () => {
  render(<AssetViewer items={[asset("a", "a.gif")]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);

  expect(screen.queryByRole("button", { name: "즐겨찾기 켜기" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "휴지통으로 이동" })).not.toBeInTheDocument();
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

it("keeps the visible image until the next asset has decoded", async () => {
  let finishDecode!: () => void;
  vi.stubGlobal("Image", class {
    src = "";
    decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
  });
  const first = asset("a", "a.png");
  const second = asset("b", "b.png");
  const { rerender } = render(<AssetViewer items={[first, second]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);

  rerender(<AssetViewer items={[first, second]} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("img", { name: "a.png" })).toHaveAttribute("src", "http://lakomics.localhost/asset/a");

  await act(async () => finishDecode());
  expect(screen.getByRole("img", { name: "b.png" })).toHaveAttribute("src", "http://lakomics.localhost/asset/b");
});

it("shows a failure placeholder instead of a stale image when preload fails", async () => {
  let decodeImpl: () => Promise<void> = () => Promise.reject(new Error("decode failed"));
  vi.stubGlobal("Image", class {
    src = "";
    complete = false;
    naturalWidth = 0;
    decode = () => decodeImpl();
  });
  const items = [asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")];
  const { rerender } = render(<AssetViewer items={items} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();

  rerender(<AssetViewer items={items} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("이미지를 불러오지 못했습니다")).toBeVisible());
  expect(screen.queryByRole("img", { name: "a.png" })).not.toBeInTheDocument();

  decodeImpl = () => Promise.resolve();
  rerender(<AssetViewer items={items} activeId="c" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("img", { name: "c.png" })).toBeInTheDocument());
  expect(screen.queryByText("이미지를 불러오지 못했습니다")).not.toBeInTheDocument();
});

it("seeks a video with Left/Right while the on-screen arrows still change assets", () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={[asset("a", "a.png"), videoAsset("v", "v.webm"), asset("c", "c.png")]} activeId="v" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "v.webm" });
  const video = screen.getByLabelText("v.webm 영상");
  Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 10 });

  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(video).toHaveProperty("currentTime", 15);
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  expect(video).toHaveProperty("currentTime", 5);
  expect(onActiveIdChange).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "다음 자산" }));
  expect(onActiveIdChange).toHaveBeenCalledWith("c");
});

it("plays/pauses a video with Space even while the next-asset button has focus", () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={[videoAsset("v", "v.webm"), asset("c", "c.png")]} activeId="v" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);
  const next = screen.getByRole("button", { name: "다음 자산" });
  next.focus();

  const down = fireEvent.keyDown(next, { key: " ", code: "Space" });
  const up = fireEvent.keyUp(next, { key: " ", code: "Space" });

  expect(play).toHaveBeenCalledOnce();
  expect(down).toBe(false);
  expect(up).toBe(false);
  expect(onActiveIdChange).not.toHaveBeenCalled();
});

it("keeps Left/Right as previous/next for a video hidden by privacy mode", () => {
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={[asset("a", "a.png"), videoAsset("v", "v.webm")]} activeId="v" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} privacyMode />);

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });

  expect(onActiveIdChange).toHaveBeenCalledWith("a");
});

it("fades the title, arrows and actions after idle and restores them on pointer or key activity", () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png")]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
    const viewer = document.querySelector<HTMLElement>(".asset-viewer")!;
    expect(viewer).toHaveAttribute("data-chrome-visible", "true");

    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS - 1));
    expect(viewer).toHaveAttribute("data-chrome-visible", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(viewer).toHaveAttribute("data-chrome-visible", "false");
    expect(viewer).toHaveClass("asset-viewer--chrome-hidden");

    fireEvent.pointerMove(viewer);
    expect(viewer).toHaveAttribute("data-chrome-visible", "true");
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS));
    expect(viewer).toHaveAttribute("data-chrome-visible", "false");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "f" });
    expect(viewer).toHaveAttribute("data-chrome-visible", "true");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the chrome visible while the pointer rests on the controls or Tab focus is inside them", () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png")]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
    const viewer = document.querySelector<HTMLElement>(".asset-viewer")!;
    const controls = document.querySelector<HTMLElement>(".asset-viewer__controls")!;

    fireEvent.pointerEnter(controls);
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS * 2));
    expect(viewer).toHaveAttribute("data-chrome-visible", "true");
    fireEvent.pointerLeave(controls);
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS));
    expect(viewer).toHaveAttribute("data-chrome-visible", "false");

    const close = screen.getByRole("button", { name: "감상 화면 닫기" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    act(() => close.focus());
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS * 2));
    expect(viewer).toHaveAttribute("data-chrome-visible", "true");

    fireEvent.pointerMove(viewer);
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS));
    expect(viewer).toHaveAttribute("data-chrome-visible", "false");
  } finally {
    vi.useRealTimers();
  }
});

function asset(id: string, originalName: string): AssetSummary {
  return { id, title: null, originalName, byteSize: 1, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } };
}

function videoAsset(id: string, originalName: string): AssetSummary {
  return { ...asset(id, originalName), media: { kind: "video", durationMs: 60_000, preparationState: "ready", scrubFrameCount: 6 } };
}
