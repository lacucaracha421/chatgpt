import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, ClassificationEntry, LibraryGateway } from "../library/types";
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

  expect(screen.queryByRole("button", { name: "다음 자산" })).not.toBeInTheDocument();
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
  expect(screen.queryByRole("button", { name: "캐릭터" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "앨범" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "이동" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "출처 열기" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "정보" })).not.toBeInTheDocument();
});

it("shows the total count, artist handle and breadcrumb date metadata", async () => {
  const gateway = { getAssetClassifications: vi.fn().mockResolvedValue(["child"]) } as unknown as LibraryGateway;
  const classifications: ClassificationEntry[] = [
    { id: "root", kind: "root", name: "폴더", parentId: null, iconKey: null, colorKey: null },
    { id: "child", kind: "tag", name: "하위", parentId: "root", iconKey: null, colorKey: null },
  ];
  const current = { ...asset("a", "a.png"), creatorHandle: "az79709363", collectedAt: new Date().toISOString() };
  render(<LibraryProvider gateway={gateway}><AssetViewer items={[current, asset("b", "b.png")]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} totalCount={9453} classifications={classifications} /></LibraryProvider>);

  expect(document.querySelector(".asset-viewer__position")).toHaveTextContent("1 / 9,453");
  expect(screen.getByText("@az79709363")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/폴더 › 하위 · \d+\.\d+ \d{2}:\d{2}/)).toBeInTheDocument());
  expect(gateway.getAssetClassifications).toHaveBeenCalledWith("a");
});

it("renders a bounded filmstrip and moves from a thumbnail", () => {
  const items = Array.from({ length: 15 }, (_, index) => asset(`asset-${index}`, `${index}.png`));
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={items} activeId="asset-7" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);

  const thumbnails = screen.getAllByRole("button", { name: /번째 자산 보기$/ });
  expect(thumbnails).toHaveLength(11);
  expect(screen.getByRole("button", { name: "8번째 자산 보기" })).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "6번째 자산 보기" }));
  expect(onActiveIdChange).toHaveBeenCalledWith("asset-5");
});

it("hides the filmstrip for videos and single assets", () => {
  const { rerender } = render(<AssetViewer items={[videoAsset("video", "video.webm"), asset("b", "b.png")]} activeId="video" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(document.querySelector(".asset-viewer__filmstrip")).not.toBeInTheDocument();
  // The video layout keeps the edge areas off the player's control bar.
  expect(document.querySelector(".asset-viewer__stage")).toHaveClass("asset-viewer__stage--video");

  rerender(<AssetViewer items={[asset("only", "only.png")]} activeId="only" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(document.querySelector(".asset-viewer__filmstrip")).not.toBeInTheDocument();
});

it("uses full-height edge controls and omits them at the ends", () => {
  const onActiveIdChange = vi.fn();
  const items = [asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")];
  const { rerender } = render(<AssetViewer items={items} activeId="a" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "이전 자산" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다음 자산" }));
  expect(onActiveIdChange).toHaveBeenCalledWith("b");

  rerender(<AssetViewer items={items} activeId="c" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "다음 자산" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "이전 자산" })).toBeInTheDocument();
});

it("toggles the docked info panel with the button and i, with Escape closing only the panel first", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<AssetViewer items={[asset("a", "a.png")]} activeId="a" onActiveIdChange={vi.fn()} onClose={onClose} renderInfo={(current) => <p>{current.originalName} 정보</p>} />);
  const dialog = screen.getByRole("dialog");

  fireEvent.click(screen.getByRole("button", { name: "정보" }));
  expect(screen.getByRole("complementary", { name: "자산 정보" })).toBeInTheDocument();
  expect(screen.getByText("a.png 정보")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.keyDown(dialog, { key: "i" });
  expect(screen.getByRole("complementary", { name: "자산 정보" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "정보 닫기" }));
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
});

it("ignores viewer shortcuts while typing in the character picker", async () => {
  const user = userEvent.setup();
  const onToggleFavorite = vi.fn();
  const onTrash = vi.fn();
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png")]} activeId="a" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} onToggleFavorite={onToggleFavorite} onTrash={onTrash}
    renderInfo={() => <p>info</p>} renderCharacterPicker={() => <input aria-label="캐릭터 찾기" />} />);
  await user.click(screen.getByRole("button", { name: "캐릭터" }));
  await user.type(screen.getByRole("textbox", { name: "캐릭터 찾기" }), "fi{ArrowRight}{Delete}");
  expect(onToggleFavorite).not.toHaveBeenCalled();
  expect(onTrash).not.toHaveBeenCalled();
  expect(onActiveIdChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
});

it("pages with the mouse wheel: down = next, up = previous, one step per notch", () => {
  const onActiveIdChange = vi.fn();
  const now = vi.spyOn(performance, "now");
  const { container } = render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")]} activeId="b" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);
  const stage = container.ownerDocument.querySelector(".asset-viewer__stage")!;
  now.mockReturnValue(1_000);
  fireEvent.wheel(stage, { deltaY: 100 });
  expect(onActiveIdChange).toHaveBeenLastCalledWith("c");
  now.mockReturnValue(1_050);
  fireEvent.wheel(stage, { deltaY: -100 });
  expect(onActiveIdChange).toHaveBeenCalledTimes(1);
  now.mockReturnValue(1_400);
  fireEvent.wheel(stage, { deltaY: -100 });
  expect(onActiveIdChange).toHaveBeenLastCalledWith("a");
  now.mockReturnValue(2_000);
  fireEvent.wheel(stage, { deltaY: 10 });
  expect(onActiveIdChange).toHaveBeenCalledTimes(2);
});

it("zooms an image with Ctrl+wheel without paging, and Ctrl+0 resets", () => {
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png")]} activeId="a" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);
  const stage = document.querySelector(".asset-viewer__stage")!;
  const zoomIn = new WheelEvent("wheel", { deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true });
  act(() => { stage.dispatchEvent(zoomIn); });
  expect(zoomIn.defaultPrevented).toBe(true);
  expect(onActiveIdChange).not.toHaveBeenCalled();
  expect(screen.getByRole("img", { name: "a.png" }).style.transform).toMatch(/scale\(1\.4/);
  expect(stage).toHaveAttribute("data-zoomed", "true");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "0", ctrlKey: true });
  expect(screen.getByRole("img", { name: "a.png" }).style.transform).toBe("");
});

it("calls near-end loading once for each loaded item count", () => {
  const onNearEnd = vi.fn();
  const items = [asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")];
  const { rerender } = render(<AssetViewer items={items} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} onNearEnd={onNearEnd} />);
  expect(onNearEnd).toHaveBeenCalledOnce();
  rerender(<AssetViewer items={items} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} onNearEnd={onNearEnd} />);
  expect(onNearEnd).toHaveBeenCalledOnce();
  const expanded = [...items, asset("d", "d.png")];
  rerender(<AssetViewer items={expanded} activeId="d" onActiveIdChange={vi.fn()} onClose={vi.fn()} onNearEnd={onNearEnd} />);
  expect(onNearEnd).toHaveBeenCalledTimes(2);
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

it("keeps the visible image until the next asset has loaded and decoded in its own element", async () => {
  let finishDecode!: () => void;
  // jsdom has no HTMLImageElement.decode; install one for this test only.
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => new Promise<void>((resolve) => { finishDecode = resolve; }) });
  onTestFinished(() => { delete (HTMLImageElement.prototype as { decode?: unknown }).decode; });
  const first = asset("a", "a.png");
  const second = asset("b", "b.png");
  const { rerender, container } = render(<AssetViewer items={[first, second]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);

  rerender(<AssetViewer items={[first, second]} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("img", { name: "a.png" })).toHaveAttribute("src", "http://lakomics.localhost/asset/a");
  const loading = container.ownerDocument.querySelector<HTMLImageElement>('img.asset-viewer__media[data-stable-image-loading]')!;
  expect(loading).toHaveAttribute("src", "http://lakomics.localhost/asset/b");
  expect(loading.style.visibility).toBe("hidden");
  expect(loading.style.position).toBe("absolute");

  fireEvent.load(loading);
  expect(screen.getByRole("img", { name: "a.png" })).toBeVisible();
  await act(async () => finishDecode());
  // The element that loaded the image is the one shown; no second fetch through a src swap.
  expect(screen.getByRole("img", { name: "b.png" })).toBe(loading);
  expect(loading).not.toHaveAttribute("data-stable-image-loading");
  expect(loading.style.visibility).toBe("");
});

it("shows a failure placeholder instead of a stale image when preload fails", async () => {
  const items = [asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")];
  const { rerender, container } = render(<AssetViewer items={items} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();

  rerender(<AssetViewer items={items} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  fireEvent.error(container.ownerDocument.querySelector<HTMLImageElement>('img.asset-viewer__media[data-stable-image-loading]')!);
  await waitFor(() => expect(screen.getByText("이미지를 불러오지 못했습니다")).toBeVisible());
  expect(screen.queryByRole("img", { name: "a.png" })).not.toBeInTheDocument();

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
    const controls = document.querySelector<HTMLElement>(".asset-viewer__topbar")!;

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
