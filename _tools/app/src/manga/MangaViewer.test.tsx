import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MangaViewer } from "./MangaViewer";

const progressApi = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../library/client", () => ({
  libraryGateway: {
    getMangaReadingProgress: progressApi.get,
    saveMangaReadingProgress: progressApi.save,
  },
}));

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

beforeEach(() => {
  progressApi.get.mockResolvedValue(null);
  progressApi.save.mockResolvedValue(undefined);
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(100);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
});

afterEach(() => { cleanup(); openUrl.mockClear(); progressApi.get.mockReset(); progressApi.save.mockReset(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("MangaViewer", () => {
  it("shows the title and page progress", async () => {
    render(<MangaViewer seriesId="s1" galleryId={null} title="Batsu Kano" pageCount={60} onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Batsu Kano" })).toBeInTheDocument();
    expect(screen.getByText("1 / 60")).toBeVisible();
  });

  it("moves to the next page with the right arrow", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await screen.findByText("1 / 60");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2 / 60")).toBeVisible();
  });

  it("moves to the previous page with the left arrow", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await screen.findByText("1 / 60");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("2 / 60")).toBeVisible();
  });

  it("stops at the first and last page", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={2} onClose={vi.fn()} />);
    await screen.findByText("1 / 2");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("1 / 2")).toBeVisible();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2 / 2")).toBeVisible();
  });

  it("closes with the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={onClose} />);
    await screen.findByText("1 / 60");
    await user.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));
    expect(progressApi.save).toHaveBeenCalledWith("s1", 1, 60);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves the resumed page on close even when the page did not change", async () => {
    progressApi.get.mockResolvedValue({ lastPage: 18, pageCount: 60 });
    const onClose = vi.fn();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={onClose} />);
    await screen.findByText("18 / 60");

    fireEvent.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));

    expect(progressApi.save).toHaveBeenCalledOnce();
    expect(progressApi.save).toHaveBeenCalledWith("s1", 18, 60);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not overwrite saved progress when loading it failed and the page did not change", async () => {
    progressApi.get.mockRejectedValue(new Error("temporarily unavailable"));
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);

    await screen.findByText("1 / 60");
    fireEvent.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));

    expect(progressApi.save).not.toHaveBeenCalled();
  });

  it("toggles spread mode with the button and shows two pages", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await screen.findByText("1 / 60");
    await user.click(screen.getByRole("button", { name: "양면 보기" }));
    expect(screen.getByText("1 / 60")).toBeVisible();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2-3 / 60")).toBeVisible();
    expect(screen.getAllByRole("img", { name: /페이지/ })).toHaveLength(2);
  });

  it("toggles spread mode with the V key", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await screen.findByText("1 / 60");
    await user.keyboard("v");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2-3 / 60")).toBeVisible();
    await user.keyboard("v");
    expect(screen.getByText("2 / 60")).toBeVisible();
  });

  it("shows the last odd page alone in spread mode", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={6} onClose={vi.fn()} />);
    await screen.findByText("1 / 6");
    await user.click(screen.getByRole("button", { name: "양면 보기" }));
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("6 / 6")).toBeVisible();
    expect(screen.getAllByRole("img", { name: /페이지/ })).toHaveLength(1);
  });

  it("preloads the next and previous pages without showing them", async () => {
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await screen.findByText("1 / 60");
    const preloads = document.querySelectorAll(".manga-viewer__preload");
    expect(preloads.length).toBeGreaterThan(0);
    expect(preloads[0]).toHaveAttribute("src", expect.stringContaining("/manga-page/s1/2"));
  });

  it("waits for saved progress and starts on that page without rendering page one first", async () => {
    let resolveProgress!: (value: { lastPage: number; pageCount: number }) => void;
    progressApi.get.mockReturnValue(new Promise(resolve => { resolveProgress = resolve; }));
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);

    expect(screen.queryByRole("heading", { name: "T" })).not.toBeInTheDocument();
    await act(async () => resolveProgress({ lastPage: 18, pageCount: 60 }));

    expect(await screen.findByText("18 / 60")).toBeVisible();
    expect(screen.queryByText("1 / 60")).not.toBeInTheDocument();
  });

  it("debounces page saves and flushes the latest page before closing", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={onClose} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));

    expect(progressApi.save).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(999));
    expect(progressApi.save).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(progressApi.save).toHaveBeenLastCalledWith("s1", 3, 60);

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    fireEvent.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));
    expect(progressApi.save).toHaveBeenLastCalledWith("s1", 4, 60);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

it("renders a kHentai link only when the series carries a gallery id", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<MangaViewer seriesId="s1" title="T" pageCount={2} galleryId="12345" onClose={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "kHentai에서 열기" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "kHentai에서 열기" }));
  expect(openUrl).toHaveBeenCalledWith("https://k-hentai.org/r/12345");

  rerender(<MangaViewer seriesId="s1" title="T" pageCount={2} galleryId={null} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.queryByRole("button", { name: "kHentai에서 열기" })).not.toBeInTheDocument());
});
