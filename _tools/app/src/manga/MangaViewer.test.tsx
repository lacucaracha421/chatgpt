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

function position(): string {
  return document.querySelector(".asset-viewer__position")?.textContent ?? "";
}

describe("MangaViewer", () => {
  it("shows the title and page progress", async () => {
    render(<MangaViewer seriesId="s1" galleryId={null} title="Batsu Kano" pageCount={60} onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Batsu Kano" })).toBeInTheDocument();
    expect(document.querySelector(".asset-viewer__title strong")).toHaveTextContent("Batsu Kano");
    expect(position()).toBe("1 / 60");
  });

  it("uses the shared reader chrome with 로컬 as the source and no bookmark", () => {
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" artist="tatsuwaipu" pageCount={60} onClose={vi.fn()} />);
    expect(document.querySelector(".manga-reader.asset-viewer")).not.toBeNull();
    expect(screen.getByText("tatsuwaipu · 로컬")).toBeVisible();
    for (const name of ["뒤로", "두 쪽 보기", "페이지 목록", "읽기 설정", "망가 뷰어 닫기"]) expect(screen.getByRole("button", { name })).toBeVisible();
    expect(screen.getByRole("slider", { name: "페이지 위치" })).toHaveValue("1");
    expect(screen.queryByRole("button", { name: "북마크" })).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves to the next page with the right arrow", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await waitFor(() => expect(position()).toBe("1 / 60"));
    await user.keyboard("{ArrowRight}");
    expect(position()).toBe("2 / 60");
  });

  it("moves to the previous page with the left arrow", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await waitFor(() => expect(position()).toBe("1 / 60"));
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");
    expect(position()).toBe("2 / 60");
  });

  it("stops at the first and last page", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={2} onClose={vi.fn()} />);
    await waitFor(() => expect(position()).toBe("1 / 2"));
    await user.keyboard("{ArrowLeft}");
    expect(position()).toBe("1 / 2");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    expect(position()).toBe("2 / 2");
  });

  it("closes with the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={onClose} />);
    await waitFor(() => expect(position()).toBe("1 / 60"));
    await user.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));
    expect(progressApi.save).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("toggles spread mode with the button and shows two pages", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await waitFor(() => expect(position()).toBe("1 / 60"));
    await user.click(screen.getByRole("button", { name: "두 쪽 보기" }));
    expect(position()).toBe("1 / 60");
    await user.keyboard("{ArrowRight}");
    expect(position()).toBe("2-3 / 60");
    expect(screen.getAllByRole("img", { name: /페이지/ })).toHaveLength(2);
  });

  it("toggles spread mode with the V key", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await waitFor(() => expect(position()).toBe("1 / 60"));
    await user.keyboard("v");
    await user.keyboard("{ArrowRight}");
    expect(position()).toBe("2-3 / 60");
    await user.keyboard("v");
    expect(position()).toBe("2 / 60");
  });

  it("shows the last odd page alone in spread mode", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={6} onClose={vi.fn()} />);
    await waitFor(() => expect(position()).toBe("1 / 6"));
    await user.click(screen.getByRole("button", { name: "두 쪽 보기" }));
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    expect(position()).toBe("6 / 6");
    expect(screen.getAllByRole("img", { name: /페이지/ })).toHaveLength(1);
  });

  it("preloads the next and previous pages without showing them", async () => {
    render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    await waitFor(() => expect(position()).toBe("1 / 60"));
    const preloads = document.querySelectorAll(".manga-viewer__preload");
    expect(preloads.length).toBeGreaterThan(0);
    expect(preloads[0]).toHaveAttribute("src", expect.stringContaining("/manga-page/s1/2"));
  });

  it("opens immediately at page one despite old saved progress and never records pages", async () => {
    progressApi.get.mockResolvedValue({ lastPage: 18, pageCount: 60 });
    const onClose = vi.fn();
    const { unmount } = render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={onClose} />);

    expect(position()).toBe("1 / 60");
    await act(async () => undefined);
    expect(progressApi.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(position()).toBe("2 / 60");
    fireEvent.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));
    unmount();
    expect(onClose).toHaveBeenCalledOnce();
    expect(progressApi.save).not.toHaveBeenCalled();
  });

  it("starts a different series at page one when the viewer stays mounted", () => {
    const { rerender } = render(<MangaViewer seriesId="s1" galleryId={null} title="T" pageCount={60} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(position()).toBe("2 / 60");

    rerender(<MangaViewer seriesId="s2" galleryId={null} title="Other" pageCount={20} onClose={vi.fn()} />);
    expect(position()).toBe("1 / 20");
    expect(progressApi.get).not.toHaveBeenCalled();
    expect(progressApi.save).not.toHaveBeenCalled();
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
