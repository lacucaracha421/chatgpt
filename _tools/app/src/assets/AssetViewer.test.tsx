import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, ClassificationEntry, LibraryGateway } from "../library/types";
import { AssetViewer, VIEWER_CHROME_IDLE_MS } from "./AssetViewer";
import { AssetInfoPanel } from "./AssetInfoPanel";
import type { AssetImageText } from "../library/types";
import { readFileSync } from "node:fs";

/** Gives the stage a 1200 x 800 box (jsdom measures none) so pointer positions map to the viewer's edge zones. */
function measureStage() {
  const stage = document.querySelector<HTMLElement>(".asset-viewer__stage")!;
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
}
const CENTRE = { clientX: 600, clientY: 400 };
const NEAR_BOTTOM = { clientX: 600, clientY: 760 };
const NEAR_TOP = { clientX: 600, clientY: 20 };
const NEAR_LEFT = { clientX: 30, clientY: 400 };
const NEAR_RIGHT = { clientX: 1170, clientY: 400 };

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
  fireEvent.click(screen.getByRole("button", { name: "좋아요" }));
  expect(onToggleFavorite).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "휴지통으로" }));
  expect(onTrash).toHaveBeenCalledTimes(2);
});

it("hides library management actions when handlers are absent", () => {
  render(<AssetViewer items={[asset("a", "a.gif")]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);

  expect(screen.queryByRole("button", { name: "좋아요" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "휴지통으로" })).not.toBeInTheDocument();
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

it("loops a video in the viewer (user 2026-10-06)", () => {
  render(<AssetViewer items={[videoAsset("video", "video.webm")]} activeId="video" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(document.querySelector("video")).toHaveProperty("loop", true);
});

it("shows the video strip when paused, hides it while playing, and omits it for single assets", () => {
  const { rerender } = render(<AssetViewer items={[videoAsset("video", "video.webm"), asset("b", "b.png")]} activeId="video" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(document.querySelector(".asset-viewer__filmstrip")).toBeInTheDocument();
  const viewer = document.querySelector<HTMLElement>('.asset-viewer')!;
  expect(viewer).toHaveAttribute('data-filmstrip-visible', 'true');
  expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('66px');
  fireEvent.play(document.querySelector('video')!);
  expect(document.querySelector('.asset-viewer')).toHaveClass('asset-viewer--playing');
  expect(viewer).toHaveAttribute('data-filmstrip-visible', 'false');
  expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('0px');
  fireEvent.pause(document.querySelector('video')!);
  expect(document.querySelector('.asset-viewer')).not.toHaveClass('asset-viewer--playing');
  expect(viewer).toHaveAttribute('data-filmstrip-visible', 'true');
  expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('66px');
  // The video layout keeps the edge areas off the player's control bar.
  expect(document.querySelector(".asset-viewer__stage")).toHaveClass("asset-viewer__stage--video");

  rerender(<AssetViewer items={[asset("only", "only.png")]} activeId="only" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(document.querySelector(".asset-viewer__filmstrip")).not.toBeInTheDocument();
  expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('0px');
});

it('preserves strip geometry across images and videos and rides above the grown strip', () => {
  vi.useFakeTimers();
  try {
    const items = [asset('a','a.png'), videoAsset('v','v.webm')];
    const props = {items, onActiveIdChange:vi.fn(), onClose:vi.fn()};
    const view = render(<AssetViewer {...props} activeId="a"/>);
    const viewer = document.querySelector<HTMLElement>('.asset-viewer')!;
    const strip = screen.getByRole('navigation', {name:'주변 자산'});
    const imageClass = strip.className;
    expect(strip.style.getPropertyValue('--filmstrip-height')).toBe('124px');
    expect(strip).not.toHaveClass('is-grown');
    view.rerender(<AssetViewer {...props} activeId="v"/>);
    expect(strip.className).toBe(imageClass);
    expect(strip.style.getPropertyValue('--filmstrip-height')).toBe('124px');
    expect(strip.style.bottom).toBe('');
    const stage = document.querySelector('.asset-viewer__media-surface');
    const media = document.querySelector('video')!;
    measureStage();
    fireEvent.pointerMove(viewer, NEAR_BOTTOM);
    expect(strip).toHaveClass('is-grown');
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('136px');
    fireEvent.play(media);
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('0px');
    act(() => vi.advanceTimersByTime(2000));
    expect(document.querySelector('.video-player')).toHaveAttribute('data-controls-visible', 'false');
    fireEvent.pause(media);
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('136px');
    expect(document.querySelector('.video-player')).toHaveAttribute('data-controls-visible', 'true');
    fireEvent.pointerMove(viewer, CENTRE);
    act(() => vi.advanceTimersByTime(220));
    expect(strip).not.toHaveClass('is-grown');
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('66px');
    expect(document.querySelector('.asset-viewer__media-surface')).toBe(stage);
    expect(document.querySelector('video')).toBe(media);
    view.rerender(<AssetViewer {...props} activeId="a"/>);
    fireEvent.pointerMove(viewer, NEAR_BOTTOM);
    expect(strip.style.getPropertyValue('--filmstrip-height')).toBe('124px');
    expect(strip).toHaveClass('is-grown');
  } finally { vi.useRealTimers(); }
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

it("ignores viewer shortcuts while typing in the info dock", async () => {
  const user = userEvent.setup();
  const onToggleFavorite = vi.fn();
  const onTrash = vi.fn();
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png")]} activeId="a" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} onToggleFavorite={onToggleFavorite} onTrash={onTrash}
    renderInfo={() => <input aria-label="정보 편집" />} />);
  await user.click(screen.getByRole("button", { name: "정보" }));
  await user.type(screen.getByRole("textbox", { name: "정보 편집" }), "fi{ArrowRight}{Delete}");
  expect(onToggleFavorite).not.toHaveBeenCalled();
  expect(onTrash).not.toHaveBeenCalled();
  expect(onActiveIdChange).not.toHaveBeenCalled();
  expect(screen.getByRole("complementary", { name: "자산 정보" })).toBeInTheDocument();
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

it("keeps the painted image and reports a failed replacement without a blank state", async () => {
  const items = [asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")];
  const { rerender, container } = render(<AssetViewer items={items} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();

  rerender(<AssetViewer items={items} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  fireEvent.error(container.ownerDocument.querySelector<HTMLImageElement>('img.asset-viewer__media[data-stable-image-loading]')!);
  await waitFor(() => expect(screen.getByText(/이미지를 불러오지 못했습니다/)).toBeVisible());
  expect(screen.queryByRole("img", { name: "a.png" })).toBeInTheDocument();

  rerender(<AssetViewer items={items} activeId="c" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
  await act(async () => fireEvent.load(document.querySelector('img.asset-viewer__media[data-stable-image-loading]')!));
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

function zoneState(viewer: HTMLElement) {
  return {
    top: viewer.getAttribute("data-top-visible") === "true",
    left: viewer.getAttribute("data-left-visible") === "true",
    right: viewer.getAttribute("data-right-visible") === "true",
    bottom: viewer.getAttribute("data-filmstrip-visible") === "true",
  };
}
const NONE = { top: false, left: false, right: false, bottom: false };

it("shows no overlay on open or while the pointer moves around the centre", () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")]} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
    const viewer = document.querySelector<HTMLElement>(".asset-viewer")!;
    measureStage();
    expect(zoneState(viewer)).toEqual(NONE);
    fireEvent.pointerMove(viewer, CENTRE);
    fireEvent.pointerMove(viewer, { clientX: 500, clientY: 300 });
    expect(zoneState(viewer)).toEqual(NONE);
  } finally {
    vi.useRealTimers();
  }
});

it("shows each overlay only when the pointer is in its own zone and hides it on leaving or after idle", () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")]} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
    const viewer = document.querySelector<HTMLElement>(".asset-viewer")!;
    measureStage();

    fireEvent.pointerMove(viewer, NEAR_BOTTOM);
    expect(zoneState(viewer)).toEqual({ ...NONE, bottom: true });
    fireEvent.pointerMove(viewer, NEAR_TOP);
    expect(zoneState(viewer)).toEqual({ ...NONE, top: true });
    fireEvent.pointerMove(viewer, NEAR_LEFT);
    expect(zoneState(viewer)).toEqual({ ...NONE, left: true });
    fireEvent.pointerMove(viewer, NEAR_RIGHT);
    expect(zoneState(viewer)).toEqual({ ...NONE, right: true });
    fireEvent.pointerMove(viewer, { clientX: 20, clientY: 20 });
    expect(zoneState(viewer)).toEqual({ ...NONE, top: true, left: true });

    // Leaving the zone hides the overlay at once.
    fireEvent.pointerMove(viewer, CENTRE);
    expect(zoneState(viewer)).toEqual(NONE);

    // Resting inside the zone hides it after the usual idle delay; moving again brings it back.
    fireEvent.pointerMove(viewer, NEAR_TOP);
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS - 1));
    expect(zoneState(viewer).top).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(zoneState(viewer)).toEqual(NONE);
    fireEvent.pointerMove(viewer, NEAR_TOP);
    expect(zoneState(viewer).top).toBe(true);

    // Leaving the viewer clears every zone.
    fireEvent.pointerLeave(viewer);
    expect(zoneState(viewer)).toEqual(NONE);
  } finally {
    vi.useRealTimers();
  }
});

it("ignores the pointer outside the stage, such as over the docked information panel", () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png")]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} renderInfo={() => <div>info</div>} />);
    const viewer = document.querySelector<HTMLElement>(".asset-viewer")!;
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "i" });
    measureStage();
    expect(screen.queryByRole("button", { name: "이전 자산" })).not.toBeInTheDocument();
    // The stage ends at x = 1200; the dock sits to the right of it.
    fireEvent.pointerMove(viewer, { clientX: 1300, clientY: 20 });
    expect(zoneState(viewer)).toEqual(NONE);
    fireEvent.pointerMove(viewer, NEAR_TOP);
    expect(zoneState(viewer).top).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps an overlay shown while the pointer rests on it, until the pointer leaves and the idle delay passes", () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")]} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
    const viewer = document.querySelector<HTMLElement>(".asset-viewer")!;
    measureStage();
    const bar = document.querySelector<HTMLElement>(".asset-viewer__topbar")!;
    const left = screen.getByRole("button", { name: "이전 자산" });

    fireEvent.pointerMove(viewer, NEAR_TOP);
    fireEvent.pointerEnter(bar);
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS * 2));
    expect(zoneState(viewer).top).toBe(true);
    fireEvent.pointerLeave(bar);
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS));
    expect(zoneState(viewer)).toEqual(NONE);

    fireEvent.pointerMove(viewer, NEAR_LEFT);
    fireEvent.pointerEnter(left);
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS * 2));
    expect(zoneState(viewer).left).toBe(true);
    fireEvent.pointerLeave(left);
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS));
    expect(zoneState(viewer)).toEqual(NONE);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the overlay that holds Tab focus shown", () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[asset("a", "a.png"), asset("b", "b.png")]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
    const viewer = document.querySelector<HTMLElement>(".asset-viewer")!;
    measureStage();

    const close = screen.getByRole("button", { name: "감상 화면 닫기" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    act(() => close.focus());
    act(() => vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS * 2));
    expect(zoneState(viewer)).toEqual({ ...NONE, top: true });

    // Pointer activity drops the keyboard hold; the pointer is at the centre, so the bar goes.
    fireEvent.pointerMove(viewer, CENTRE);
    expect(zoneState(viewer)).toEqual(NONE);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a paused video's strip, and hides it while playing even near the bottom (the player's own bar shows)", () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[videoAsset("v", "v.webm"), asset("b", "b.png")]} activeId="v" onActiveIdChange={vi.fn()} onClose={vi.fn()} />);
    const viewer = document.querySelector<HTMLElement>(".asset-viewer")!;
    measureStage();
    expect(viewer).toHaveAttribute("data-filmstrip-visible", "true");
    fireEvent.pointerMove(viewer, CENTRE);
    expect(viewer).toHaveAttribute("data-filmstrip-visible", "true");
    fireEvent.play(document.querySelector("video")!);
    fireEvent.pointerMove(viewer, NEAR_BOTTOM);
    expect(viewer).toHaveAttribute("data-filmstrip-visible", "false");
    fireEvent.pointerMove(document.querySelector(".video-player")!, NEAR_BOTTOM);
    expect(document.querySelector(".video-player")).toHaveAttribute("data-controls-visible", "true");
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

const imageTextFixture: AssetImageText = { digest: "first", lines: [
  { original: "ねえ", korean: "있잖아", box: { x0: 100, y0: 200, x1: 300, y1: 400 } },
  { original: "はい", korean: "응", box: { x0: 600, y0: 700, x1: 800, y1: 900 } },
] };

it("keeps desktop notes white while zooming without reading a canvas", async () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(300);
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  const style = document.createElement("style");
  style.textContent = readFileSync("src/shared/viewer/image-text.css", "utf8");
  document.head.append(style);
  onTestFinished(() => style.remove());
  const gateway = { assetImageText: vi.fn().mockResolvedValue(imageTextFixture) } as unknown as LibraryGateway;
  render(textViewer(gateway));
  fireEvent.click(await screen.findByRole("button", { name: "번역" }));
  const checkNotes = () => {
    for (const name of ["1번 대사", "2번 대사"]) {
      const note = screen.getByRole("button", { name });
      expect(note.style.background).toBe("");
      expect(note.style.color).toBe("");
      expect(getComputedStyle(note).backgroundColor).toBe("rgb(255, 255, 255)");
      expect(getComputedStyle(note).color).toBe("rgb(28, 29, 31)");
    }
  };
  checkNotes();
  fireEvent.wheel(document.querySelector(".asset-viewer__stage")!, { deltaY: -100, clientX: 300, clientY: 200 });
  checkNotes();
  expect(getContext).not.toHaveBeenCalled();
});

function textViewer(gateway: LibraryGateway, activeId: string | null = "a", extra = {}) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  return <LibraryProvider gateway={gateway}><AssetViewer items={[asset("a", "a.png"), asset("b", "b.png"), videoAsset("v", "v.mp4")]} activeId={activeId} onActiveIdChange={vi.fn()} onClose={vi.fn()} renderInfo={item => <AssetInfoPanel assets={[item]} preview={false} />} {...extra} /></LibraryProvider>;
}

it.each(["Escape", "감상 화면 닫기", "뒤로"])("hides all translation overlays as soon as %s starts the viewer exit", async (trigger) => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/shared/viewer/image-text.css", "utf8").replace(/@import[^;]+;/g, "");
  document.head.append(style);
  onTestFinished(() => style.remove());
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const animations: Animation[] = [];
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: vi.fn(() => {
    const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
    animations.push(animation);
    return animation;
  }) });
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
    else delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const gateway = { assetImageText: vi.fn().mockResolvedValue({ ...imageTextFixture, lines: [
    ...imageTextFixture.lines, { original: "保存", korean: "위치 없는 문장" },
  ] }) } as unknown as LibraryGateway;
  const onClose = vi.fn();
  render(textViewer(gateway, "a", { onClose }));
  fireEvent.click(await screen.findByRole("button", { name: "번역" }));
  fireEvent.click(screen.getByRole("button", { name: "정보 닫기" }));
  const notes = screen.getByRole("group", { name: "이미지 글자 번역" });
  const unpositioned = screen.getByRole("region", { name: "위치 없는 번역" });
  fireEvent.click(screen.getByRole("button", { name: "1번 대사" }));
  const card = screen.getByRole("region", { name: "대사 번역" });
  expect(notes).toBeVisible();
  expect(unpositioned).toBeVisible();
  expect(card).toBeVisible();
  if (trigger === "Escape") {
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(card).not.toBeInTheDocument();
    expect(notes).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
  } else fireEvent.click(screen.getByRole("button", { name: trigger }));
  expect(document.querySelector(".asset-viewer")).toHaveAttribute("data-viewer-closing", "true");
  expect(getComputedStyle(notes).display).toBe("none");
  expect(getComputedStyle(unpositioned).display).toBe("none");
  expect(card).not.toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
  // Keep the exit pending: notes must disappear before the media animation finishes.
  act(() => animations.find(animation => animation.onfinish)?.onfinish?.(new Event("finish") as AnimationPlaybackEvent));
  expect(onClose).toHaveBeenCalledOnce();
});

it("no text means no translation button or section even in the open information dock", async () => {
  const gateway = { assetImageText: vi.fn().mockResolvedValue(null), refreshAssetImageText: vi.fn().mockResolvedValue(null) } as unknown as LibraryGateway;
  render(textViewer(gateway));
  await waitFor(() => expect(gateway.refreshAssetImageText).toHaveBeenCalledWith("a"));
  fireEvent.click(screen.getByRole("button", { name: "정보" }));
  expect(screen.queryByRole("button", { name: "번역" })).toBeNull();
  expect(document.querySelector('[data-info-section="image-text"]')).toBeNull();
});

it("toggles translation notes without an information dock and closes the card before the viewer", async () => {
  const gateway = { assetImageText: vi.fn().mockResolvedValue(imageTextFixture) } as unknown as LibraryGateway;
  const onClose = vi.fn();
  render(textViewer(gateway, "a", {renderInfo: undefined, onClose}));
  const toggle = await screen.findByRole("button", {name: "번역"});
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("complementary")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "1번 대사"}));
  expect(screen.getByRole("region", {name: "대사 번역"})).toHaveTextContent("ねえ있잖아");
  fireEvent.keyDown(screen.getByRole("dialog"), {key: "Escape"});
  expect(screen.queryByRole("region", {name: "대사 번역"})).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(screen.queryByRole("button", {name: "1번 대사"})).toBeNull();
});

it("shows saved translations without boxes in the viewer without requiring the information dock", async () => {
  // Four of the six production payloads have only original/korean strings (no box key).
  const text: AssetImageText = { digest: "legacy-unpositioned", lines: Array.from({length: 10}, (_, i) => ({
    original: `保存された文章 ${i + 1}`, korean: `저장된 번역 문장 ${i + 1}`,
  })) };
  const gateway = { assetImageText: vi.fn().mockResolvedValue(text) } as unknown as LibraryGateway;
  render(textViewer(gateway, "a", {renderInfo: undefined}));
  const toggle = await screen.findByRole("button", {name: "번역"});
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  const translations = screen.getByRole("region", {name: "위치 없는 번역"});
  expect(within(translations).getAllByRole("button")).toHaveLength(10);
  expect(translations).toHaveTextContent("저장된 번역 문장 10");
  expect(screen.queryByRole("complementary")).toBeNull();
  fireEvent.click(toggle);
  expect(screen.queryByRole("region", {name: "위치 없는 번역"})).toBeNull();
});

it("starts folded; button/T unfold; marker and row selection link both ways and clear on a second click", async () => {
  const gateway = { assetImageText: vi.fn().mockResolvedValue(imageTextFixture), refreshAssetImageText: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as LibraryGateway;
  const { rerender } = render(textViewer(gateway));
  await screen.findByRole("button", { name: "번역" });
  expect(screen.queryByRole("button", { name: "1번 대사" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "정보" }));
  expect(screen.getByRole("button", { name: /번역.*2줄/ })).toHaveAttribute("aria-expanded", "false");
  expect(document.querySelector('.asset-info-panel')?.firstElementChild).toHaveAttribute("data-info-section", "image-text");
  fireEvent.click(screen.getByRole("button", { name: "번역" }));
  fireEvent.click(screen.getByRole("button", { name: "1번 대사" }));
  expect(screen.getByRole("button", { name: /있잖아.*ねえ/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /있잖아.*ねえ/ }));
  expect(screen.getByRole("button", { name: "1번 대사" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: /응.*はい/ }));
  expect(screen.getByRole("button", { name: "2번 대사" })).toHaveAttribute("aria-pressed", "true");
  expect(Number(screen.getByRole("button", { name: "2번 대사" }).style.zIndex)).toBeGreaterThan(Number(screen.getByRole("button", { name: "1번 대사" }).style.zIndex));
  fireEvent.click(screen.getByRole("button", { name: "2번 대사" }));
  expect(screen.getByRole("button", { name: /응.*はい/ })).toHaveAttribute("aria-pressed", "false");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "t" });
  expect(screen.queryByRole("button", { name: "1번 대사" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "T" });
  expect(screen.getByRole("button", { name: "1번 대사" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "출처 정보 편집" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "계정명" }), { key: "t" });
  expect(screen.getByRole("button", { name: /번역.*2줄/ })).toHaveAttribute("aria-expanded", "true");
  rerender(textViewer(gateway, null));
  rerender(textViewer(gateway));
  await screen.findByRole("button", { name: "번역" });
  fireEvent.click(screen.getByRole("button", { name: "정보" }));
  expect(screen.getByRole("button", { name: /번역.*2줄/ })).toHaveAttribute("aria-expanded", "false");
});

it("holds outgoing rows until the decoded slot swap, then swaps rows/markers and clears selection with fold state retained", async () => {
  const second = { digest: "second", lines: [{ ...imageTextFixture.lines[0], korean: "다음 그림" }] };
  const gateway = { assetImageText: vi.fn((id: string) => Promise.resolve(id === "a" ? imageTextFixture : second)) } as unknown as LibraryGateway;
  const { rerender } = render(textViewer(gateway));
  fireEvent.load(screen.getByRole("img", { name: "a.png" }));
  fireEvent.click(await screen.findByRole("button", { name: "번역" }));
  // 번역 opens the info dock itself.
  fireEvent.click(screen.getByRole("button", { name: "1번 대사" }));
  let decode!: () => void;
  const spare = document.querySelector<HTMLImageElement>('.asset-viewer__media[src$="/asset/b"]')!;
  spare.decode = () => new Promise<void>(resolve => { decode = resolve; });
  rerender(textViewer(gateway, "b"));
  fireEvent.load(spare);
  await waitFor(() => expect(gateway.assetImageText).toHaveBeenCalledWith("b"));
  expect(within(document.querySelector(".image-text-section")!).getByText("있잖아")).toBeInTheDocument();
  expect(within(document.querySelector(".image-text-section")!).queryByText("다음 그림")).toBeNull();
  expect(document.querySelector('[data-line="0"]')).toHaveAttribute("aria-pressed", "false");
  await act(async () => { decode(); });
  await within(document.querySelector(".image-text-section")!).findByText("다음 그림");
  expect(within(document.querySelector(".image-text-section")!).queryByText("있잖아")).toBeNull();
  expect(screen.getByRole("button", { name: /번역.*1줄/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "1번 대사" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByRole("button", { name: "2번 대사" })).toBeNull();
});

it("refreshes only changed digests and retains the local rows during refresh", async () => {
  let resolve!: (value: AssetImageText | null) => void;
  const gateway = { assetImageText: vi.fn().mockResolvedValue(imageTextFixture), refreshAssetImageText: vi.fn(() => new Promise<AssetImageText | null>(done => { resolve = done; })) } as unknown as LibraryGateway;
  render(textViewer(gateway));
  fireEvent.click(await screen.findByRole("button", { name: "번역" }));
  // 번역 opens the info dock itself.
  expect(within(document.querySelector(".image-text-section")!).getByText("있잖아")).toBeInTheDocument();
  await act(async () => resolve({ digest: "changed", lines: [{ ...imageTextFixture.lines[0], korean: "갱신된 번역" }] }));
  expect(within(document.querySelector(".image-text-section")!).getByText("갱신된 번역")).toBeInTheDocument();
  expect(within(document.querySelector(".image-text-section")!).queryByText("있잖아")).toBeNull();
});

it("ignores changed lines under an unchanged digest", async () => {
  let resolve!: (value: AssetImageText) => void;
  const gateway = { assetImageText: vi.fn().mockResolvedValue(imageTextFixture), refreshAssetImageText: vi.fn(() => new Promise<AssetImageText>(done => { resolve = done; })) } as unknown as LibraryGateway;
  render(textViewer(gateway));
  fireEvent.click(await screen.findByRole("button", { name: "번역" }));
  // 번역 opens the info dock itself.
  await act(async () => resolve({ ...imageTextFixture, lines: [{ ...imageTextFixture.lines[0], korean: "잘못 바뀐 내용" }] }));
  expect(within(document.querySelector(".image-text-section")!).queryByText("잘못 바뀐 내용")).toBeNull();
  expect(within(document.querySelector(".image-text-section")!).getByText("있잖아")).toBeInTheDocument();
});

it("shows a delayed busy label after 400ms when the current image text is still loading", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: AssetImageText) => void;
    const gateway = { assetImageText: vi.fn(() => new Promise<AssetImageText>(done => { resolve = done; })) } as unknown as LibraryGateway;
    render(textViewer(gateway));
    fireEvent.click(screen.getByRole("button", { name: "정보" }));
    expect(screen.queryByText("불러오는 중")).toBeNull();
    act(() => vi.advanceTimersByTime(399));
    expect(document.querySelector(".image-text-section")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(screen.getByRole("button", { name: /번역.*0줄/ }));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByText("불러오는 중")).toBeInTheDocument();
    await act(async () => resolve(imageTextFixture));
    expect(within(document.querySelector(".image-text-section")!).getByText("있잖아")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(400));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByText("불러오는 중")).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("pans an off-screen row marker into view over 200ms without changing zoom", async () => {
  const gateway = { assetImageText: vi.fn().mockResolvedValue(imageTextFixture) } as unknown as LibraryGateway;
  render(textViewer(gateway));
  const stage = document.querySelector<HTMLElement>(".asset-viewer__stage")!;
  const image = screen.getByRole("img", { name: "a.png" });
  Object.defineProperties(stage, { clientWidth: { configurable: true, value: 600 }, clientHeight: { configurable: true, value: 400 } });
  Object.defineProperties(image, { offsetWidth: { configurable: true, value: 600 }, offsetHeight: { configurable: true, value: 300 }, naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 100 } });
  fireEvent.load(image);
  fireEvent.click(await screen.findByRole("button", { name: "번역" }));
  // 번역 opens the info dock itself.
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: -600, clientX: 0, clientY: 0 });
  const before = image.style.transform;
  fireEvent.click(screen.getByRole("button", { name: /응.*はい/ }));
  expect(image.style.transform).not.toBe(before);
  expect(image.style.transform.match(/scale\(([^)]+)\)/)?.[1]).toBe(before.match(/scale\(([^)]+)\)/)?.[1]);
  expect(image).toHaveClass("asset-viewer__media--panning");
  expect(document.querySelector(".image-text-notes")).toHaveAttribute("data-panning", "true");
  await waitFor(() => expect(image).not.toHaveClass("asset-viewer__media--panning"));
});

it("does not expose translations on an NSFW cover", async () => {
  const { PrivacyProvider } = await import("../privacy/PrivacyContext");
  const gateway = { assetImageText: vi.fn().mockResolvedValue(imageTextFixture) } as unknown as LibraryGateway;
  const explicit = { ...asset("e", "explicit.png"), contentRating: "e" as const };
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()} nsfwFilter><LibraryProvider gateway={gateway}><AssetViewer items={[explicit]} activeId="e" onActiveIdChange={vi.fn()} onClose={vi.fn()} renderInfo={item => <AssetInfoPanel assets={[item]} preview={false} />} /></LibraryProvider></PrivacyProvider>);
  fireEvent.click(screen.getByRole("button", { name: "정보" }));
  expect(gateway.assetImageText).not.toHaveBeenCalled();
  expect(document.querySelector(".image-text-section, .image-text-notes")).toBeNull();
});

it.each([{ activeId: "v" }, { mediaSource: "vault" }, { privacyMode: true }])("videos/vault/privacy have no translation UI or requests (%j)", async props => {
  const gateway = { assetImageText: vi.fn().mockResolvedValue(imageTextFixture) } as unknown as LibraryGateway;
  render(textViewer(gateway, "a", props));
  fireEvent.click(screen.getByRole("button", { name: "정보" }));
  expect(gateway.assetImageText).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "번역" })).toBeNull();
  expect(document.querySelector(".image-text-section, .image-text-notes")).toBeNull();
});

it("warms only the next library image, never vault, private or video media", () => {
  const items = [asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")];
  const draw = (extra = {}) => <AssetViewer items={items} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} {...extra} />;
  const { rerender } = render(draw());
  fireEvent.load(screen.getByRole("img", { name: "a.png" }));
  expect(document.querySelectorAll('.asset-viewer__media')).toHaveLength(2);
  expect(document.querySelector('.asset-viewer__media[src$="/asset/b"]')).toHaveAttribute("aria-hidden", "true");
  expect(document.querySelector('.asset-viewer__media[src$="/asset/c"]')).toBeNull();
  rerender(draw({ privacyMode: true }));
  expect(document.querySelector('.asset-viewer__media')).toBeNull();
  rerender(draw({ mediaSource: "vault" }));
  fireEvent.load(screen.getByRole("img", { name: "a.png" }));
  expect(document.querySelectorAll('.asset-viewer__media')).toHaveLength(1);
  rerender(draw({ privacyMode: true }));
  rerender(draw({ items: [items[0], videoAsset("v", "v.mp4")] }));
  fireEvent.load(screen.getByRole("img", { name: "a.png" }));
  expect(document.querySelectorAll('.asset-viewer__media')).toHaveLength(1);
});

it('grows the strip near the bottom and shrinks after the pointer leaves', () => {
  vi.useFakeTimers();
  try {
    render(<AssetViewer items={[asset('a','a.png'),asset('b','b.png')]} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()}/>);
    const viewer=document.querySelector<HTMLElement>('.asset-viewer')!;
    measureStage();
    fireEvent.pointerMove(viewer,NEAR_BOTTOM);
    expect(screen.getByRole('navigation',{name:'주변 자산'})).toHaveClass('is-grown');
    fireEvent.pointerMove(viewer,CENTRE);
    act(()=>vi.advanceTimersByTime(220));
    expect(screen.getByRole('navigation',{name:'주변 자산'})).not.toHaveClass('is-grown');
  } finally {vi.useRealTimers();}
});

it('NSFW viewer and filmstrip use each rating and never preload the masked neighbour',async()=>{
  const {PrivacyProvider}=await import('../privacy/PrivacyContext');
  const items=[{...asset('g','safe.png'),contentRating:'g' as const},{...asset('e','explicit.png'),contentRating:'e' as const},asset('u','unknown.png')];
  const draw=(activeId:string,privacy=false)=><PrivacyProvider privacyMode={privacy} setPrivacyMode={vi.fn()} nsfwFilter><AssetViewer items={items} activeId={activeId} onActiveIdChange={vi.fn()} onClose={vi.fn()}/></PrivacyProvider>;
  const {rerender}=render(draw('e'));
  expect(document.querySelector('.asset-viewer__media-surface img')).toBeNull();
  expect([...document.querySelectorAll('img[src]')].every(img=>img.getAttribute('src')?.includes('/thumbnail/g'))).toBe(true);
  rerender(draw('g'));expect(document.querySelector('.asset-viewer__media-surface img')).toHaveAttribute('src','http://lakomics.localhost/asset/g');
  fireEvent.load(document.querySelector('.asset-viewer__media-surface img')!);
  expect(document.querySelector('img[src*="/asset/e"]')).toBeNull();
  rerender(draw('g',true));expect(document.querySelector('img[src]')).toBeNull();
});

it("paints the info dock above the absolutely positioned zoom backdrop", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("src/assets/asset-viewer.css", "utf8");
  // The backdrop covers the whole frame; a non-positioned dock would be painted under it (empty black panel).
  expect(css).toMatch(/\.asset-viewer__backdrop \{[^}]*position: absolute;/);
  expect(css).toMatch(/\.asset-viewer__dock \{[^}]*position: relative;[^}]*z-index: 1;/);
});

it("offers 이 프레임을 썸네일로 on a video and passes the current playback time", async () => {
  const onSetVideoThumbnail = vi.fn();
  const items = [videoAsset("video", "video.webm"), asset("b", "b.png")];
  const { container, rerender } = render(<AssetViewer items={items} activeId="video" onActiveIdChange={vi.fn()} onClose={vi.fn()} onSetVideoThumbnail={onSetVideoThumbnail} />);
  const video = container.ownerDocument.querySelector("video")!;
  Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 12.3456 });
  fireEvent.contextMenu(container.ownerDocument.querySelector("[data-viewer-media]")!);
  await userEvent.click(await screen.findByRole("menuitem", { name: "이 프레임을 썸네일로" }));
  expect(onSetVideoThumbnail).toHaveBeenCalledWith(items[0], 12_346);

  // Images, privacy mode and hosts without the handler get no menu.
  for (const props of [{ activeId: "b" }, { privacyMode: true }, { onSetVideoThumbnail: undefined }]) {
    rerender(<AssetViewer items={items} activeId="video" onActiveIdChange={vi.fn()} onClose={vi.fn()} onSetVideoThumbnail={onSetVideoThumbnail} {...props} />);
    const surface = container.ownerDocument.querySelector("[data-viewer-media]");
    if (surface) fireEvent.contextMenu(surface);
    expect(screen.queryByRole("menuitem", { name: "이 프레임을 썸네일로" })).not.toBeInTheDocument();
  }
});
