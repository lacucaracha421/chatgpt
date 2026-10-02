import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_PREFERENCES_KEY } from "../preferences/uiPreferences";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { VIEWER_CHROME_IDLE_MS } from "../assets/AssetViewer";
import { PageViewer } from "./PageViewer";
import { BackNavigationProvider, useBackRequest } from "../shared/navigation/BackNavigation";

beforeEach(() => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(100);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function seedReaderPrefs(value: object) {
  localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(value));
}

function viewerProps(overrides: object = {}) {
  return {
    title: "Remote",
    pageUrls: ["page-1", "page-2", "page-3", "page-4", "page-5", "page-6"],
    initialPage: 1,
    sourceLabel: "K-Hentai",
    onPageChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function shownImages(): string[] {
  return Array.from(
    document.querySelectorAll('[data-reader-buffer="active"] .manga-reader__image'),
    (element) => element.getAttribute("alt") ?? "",
  ).filter((alt) => alt.endsWith("페이지"));
}

function position(): string {
  return document.querySelector(".asset-viewer__position")?.textContent ?? "";
}

describe("PageViewer", () => {
  it("keeps the painted page mounted while the next page is still loading", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    const user = userEvent.setup();
    render(<PageViewer {...viewerProps()} />);
    const painted = screen.getByRole("img", { name: "Remote 1페이지" });

    await user.keyboard("{ArrowRight}");

    expect(painted).toBeInTheDocument();
    expect(document.querySelector('[data-reader-buffer="pending"] img'))
      .toHaveAttribute("src", "page-2");
  });

  it("starts at the restored page and identifies the source", () => {
    render(<PageViewer
      title="Remote"
      pageUrls={["page-1", "page-2", "page-3"]}
      initialPage={2}
      sourceLabel="K-Hentai"
      onPageChange={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(position()).toBe("2 / 3");
    expect(screen.getByText("K-Hentai")).toBeVisible();
    expect(screen.getByRole("img", { name: "Remote 2페이지" })).toHaveAttribute("src", "page-2");
  });

  it("reports navigation and shows a failed-image placeholder", async () => {
    const onPageChange = vi.fn();
    render(<PageViewer
      title="Remote"
      pageUrls={["page-1", "page-2"]}
      initialPage={1}
      sourceLabel="K-Hentai"
      onPageChange={onPageChange}
      onClose={vi.fn()}
    />);
    await userEvent.keyboard("{ArrowRight}");
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    fireEvent.error(screen.getByRole("img", { name: "Remote 2페이지" }));
    expect(screen.getByText("2페이지를 불러오지 못했습니다")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(screen.getByRole("img", { name: "Remote 2페이지" })).toHaveAttribute("src", "page-2");
    expect(position()).toBe("2 / 2");
  });

  it("keeps a failed page retryable until its URL resolver succeeds", async () => {
    const onRetryPage = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    render(<PageViewer {...viewerProps({ onRetryPage })} />);
    fireEvent.error(screen.getByRole("img", { name: "Remote 1페이지" }));
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetryPage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img", { name: "Remote 1페이지" })).toBeVisible();
  });

  it("preloads the previous page and five pages ahead", () => {
    render(<PageViewer
      title="Remote"
      pageUrls={Array.from({ length: 10 }, (_, index) => `page-${index + 1}`)}
      initialPage={3}
      sourceLabel="K-Hentai"
      onPageChange={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(Array.from(document.querySelectorAll(".manga-viewer__preload"), (image) => image.getAttribute("src")))
      .toEqual(["page-2", "page-4", "page-5", "page-6", "page-7", "page-8"]);
  });

  it("keeps pointer-only page edge navigation out of keyboard focus", async () => {
    const user = userEvent.setup();
    render(<PageViewer
      title="Remote"
      pageUrls={["page-1", "page-2"]}
      initialPage={1}
      sourceLabel="K-Hentai"
      onPageChange={vi.fn()}
      onClose={vi.fn()}
    />);
    const nextEdge = document.querySelector<HTMLElement>(".asset-viewer__edge--right")!;

    await user.click(nextEdge);

    expect(document.activeElement).not.toBe(nextEdge);
    expect(position()).toBe("2 / 2");
  });

  it("masks pages and skips preloading in privacy mode", () => {
    render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}>
      <PageViewer
        title="Remote"
        pageUrls={Array.from({ length: 10 }, (_, index) => `page-${index + 1}`)}
        initialPage={3}
        sourceLabel="K-Hentai"
        onPageChange={vi.fn()}
        onClose={vi.fn()}
      />
    </PrivacyProvider>);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status", { name: "비공개 모드" })).toHaveLength(1);
    expect(document.querySelectorAll(".manga-viewer__preload")).toHaveLength(0);
  });

  it("pairs cover-single spreads and keeps boundaries stable", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<PageViewer {...viewerProps({ onPageChange })} />);

    await user.keyboard("v");
    expect(position()).toBe("1 / 6");
    await user.keyboard("{ArrowRight}");
    expect(position()).toBe("2-3 / 6");
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    await user.keyboard("{ArrowRight}");
    expect(position()).toBe("4-5 / 6");
    await user.keyboard("{ArrowRight}");
    expect(position()).toBe("6 / 6");
    expect(onPageChange).toHaveBeenLastCalledWith(6);
  });

  it("shows LTR spreads in logical order", async () => {
    const user = userEvent.setup();
    render(<PageViewer {...viewerProps({ initialPage: 2 })} />);

    await user.keyboard("v");
    expect(shownImages()).toEqual(["Remote 2페이지", "Remote 3페이지"]);
  });

  it("shows RTL spreads mirrored without renumbering", async () => {
    seedReaderPrefs({ mangaReadingDirection: "rtl" });
    const user = userEvent.setup();
    render(<PageViewer {...viewerProps({ initialPage: 2 })} />);

    await user.keyboard("v");
    expect(shownImages()).toEqual(["Remote 3페이지", "Remote 2페이지"]);
    expect(position()).toBe("2-3 / 6");
  });

  it("navigates physical edges per direction", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PageViewer {...viewerProps({ initialPage: 2 })} />);
    const edge = (side: "left" | "right") => document.querySelector<HTMLElement>(`.manga-reader__edge.asset-viewer__edge--${side}`);

    await user.click(edge("left")!);
    expect(position()).toBe("1 / 6");
    expect(edge("left")).toBeNull();
    await user.click(edge("right")!);
    expect(position()).toBe("2 / 6");
    unmount();

    seedReaderPrefs({ mangaReadingDirection: "rtl" });
    render(<PageViewer {...viewerProps({ initialPage: 1 })} />);
    expect(edge("right")).toBeNull();
    expect(edge("left")).toHaveAccessibleName("다음 페이지");
    await user.click(edge("left")!);
    expect(position()).toBe("2 / 6");
  });

  it("maps arrow keys per direction", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const { unmount } = render(<PageViewer {...viewerProps({ initialPage: 2, onPageChange })} />);

    await user.keyboard("{ArrowLeft}");
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    unmount();

    seedReaderPrefs({ mangaReadingDirection: "rtl" });
    const rtlChange = vi.fn();
    render(<PageViewer {...viewerProps({ initialPage: 1, onPageChange: rtlChange })} />);
    await user.keyboard("{ArrowLeft}");
    expect(rtlChange).toHaveBeenLastCalledWith(2);
    await user.keyboard("{ArrowRight}");
    expect(rtlChange).toHaveBeenLastCalledWith(1);
  });

  it("switches mode and direction without moving or reporting progress", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<PageViewer {...viewerProps({ initialPage: 3, onPageChange })} />);

    await user.keyboard("v");
    expect(shownImages()).toEqual(["Remote 2페이지", "Remote 3페이지"]);
    expect(onPageChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "읽기 설정" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "오른쪽에서 왼쪽으로 읽기" }));
    expect(shownImages()).toEqual(["Remote 3페이지", "Remote 2페이지"]);
    expect(position()).toBe("2-3 / 6");
    expect(onPageChange).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}").mangaReadingDirection).toBe("rtl");
  });

  it("opens the overview, jumps to a page, and returns focus", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<PageViewer {...viewerProps({ onPageChange })} />);

    await user.click(screen.getByRole("button", { name: "페이지 목록" }));
    expect(screen.getByRole("dialog", { name: "페이지 목록" })).toBeVisible();
    expect(screen.getByRole("button", { name: "1페이지로 이동" })).toHaveAttribute("aria-current", "true");

    await user.click(screen.getByRole("button", { name: "4페이지로 이동" }));
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    expect(position()).toBe("4 / 6");
    expect(screen.queryByRole("dialog", { name: "페이지 목록" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "페이지 목록" })).toHaveFocus();
  });

  it("closes the overview on Escape without closing the viewer", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PageViewer {...viewerProps({ onClose })} />);

    await user.click(screen.getByRole("button", { name: "페이지 목록" }));
    expect(screen.getByRole("dialog", { name: "페이지 목록" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "페이지 목록" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(position()).toBe("1 / 6");
  });

  it("returns from the overview before closing the viewer through shared back navigation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let requestBack = () => false;
    function BackProbe() { requestBack = useBackRequest(); return null; }
    const { act } = await import("@testing-library/react");
    render(<BackNavigationProvider><BackProbe /><PageViewer {...viewerProps({ initialPage: 3, onClose })} /></BackNavigationProvider>);
    await user.click(screen.getByRole("button", { name: "페이지 목록" }));
    act(() => { requestBack(); });
    expect(screen.queryByRole("dialog", { name: "페이지 목록" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(position()).toBe("3 / 6");
    await user.click(screen.getByRole("button", { name: "페이지 목록" }));
    await user.click(screen.getByRole("button", { name: "뷰어로 돌아가기" }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => { requestBack(); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lets an open settings menu own Escape before the overview", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PageViewer {...viewerProps({ onClose })} />);

    await user.click(screen.getByRole("button", { name: "페이지 목록" }));
    await user.click(screen.getByRole("button", { name: "읽기 설정" }));
    expect(screen.getByRole("menu")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "페이지 목록" })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reaches viewer close on Escape with no nested transient open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PageViewer {...viewerProps({ onClose })} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes an open reader and removes all image sources when privacy turns on", () => {
    const close = vi.fn();
    const { container, rerender } = render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}>
      <PageViewer {...viewerProps({onClose: close})} />
    </PrivacyProvider>);
    expect(container.querySelector("img") || screen.queryAllByRole("img").length).toBeTruthy();
    rerender(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}>
      <PageViewer {...viewerProps({onClose: close})} />
    </PrivacyProvider>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector("img[src]")).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("restores persisted reader preferences on open", async () => {
    seedReaderPrefs({ mangaReadingDirection: "rtl", mangaPageMode: "double" });
    render(<PageViewer {...viewerProps({ initialPage: 2 })} />);

    expect(position()).toBe("2-3 / 6");
    expect(shownImages()).toEqual(["Remote 3페이지", "Remote 2페이지"]);
  });

  it("applies margin and gap preferences to the spread", async () => {
    const user = userEvent.setup();
    render(<PageViewer {...viewerProps()} />);

    await user.click(screen.getByRole("button", { name: "읽기 설정" }));
    await user.click(screen.getByRole("menuitemradio", { name: "여백: 넓게" }));
    await user.click(screen.getByRole("button", { name: "읽기 설정" }));
    await user.click(screen.getByRole("menuitemradio", { name: "페이지 간격: 넓게" }));

    const spread = document.querySelector('[data-reader-buffer="active"] .manga-reader__spread') as HTMLElement;
    expect(spread.style.padding).toBe("48px");
    expect(spread.style.columnGap).toBe("24px");
  });

  it("preloads the previous spread and logical pages ahead in double mode", () => {
    render(<PageViewer {...viewerProps({
      pageUrls: Array.from({ length: 10 }, (_, index) => `page-${index + 1}`),
      initialPage: 2,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "두 쪽 보기" }));

    expect(Array.from(document.querySelectorAll(".manga-viewer__preload"), (image) => image.getAttribute("src")))
      .toEqual(["page-1", "page-4", "page-5", "page-6", "page-7"]);
  });

  it("keeps logical preload order in RTL", () => {
    seedReaderPrefs({ mangaReadingDirection: "rtl" });
    render(<PageViewer {...viewerProps({
      pageUrls: Array.from({ length: 10 }, (_, index) => `page-${index + 1}`),
      initialPage: 2,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "두 쪽 보기" }));

    expect(Array.from(document.querySelectorAll(".manga-viewer__preload"), (image) => image.getAttribute("src")))
      .toEqual(["page-1", "page-4", "page-5", "page-6", "page-7"]);
  });

  it("does not report progress for presentation-only changes", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<PageViewer {...viewerProps({ onPageChange })} />);

    await user.keyboard("v");
    await user.click(screen.getByRole("button", { name: "읽기 설정" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "오른쪽에서 왼쪽으로 읽기" }));
    expect(onPageChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "읽기 설정" }));
    await user.click(screen.getByRole("menuitemradio", { name: "여백: 넓게" }));
    expect(onPageChange).not.toHaveBeenCalled();

    await user.keyboard("{ArrowRight}");
    expect(onPageChange).toHaveBeenCalledTimes(1);
  });

  it("keeps one tab stop in the overview and moves with arrows", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<PageViewer {...viewerProps({ onPageChange })} />);

    await user.click(screen.getByRole("button", { name: "페이지 목록" }));
    const buttons = () => Array.from(
      document.querySelectorAll(".manga-viewer__overview-item"),
      (element) => element as HTMLElement,
    );
    expect(buttons().map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    expect(buttons()[0]).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(buttons()[1]).toHaveFocus();
    expect(buttons().map((button) => button.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]);

    await user.keyboard("{End}");
    expect(buttons()[5]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onPageChange).toHaveBeenLastCalledWith(6);
    expect(screen.queryByRole("dialog", { name: "페이지 목록" })).not.toBeInTheDocument();
  });

  it("shows the immersive chrome: position, title, artist · source, and the bookmark only when given", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { unmount } = render(<PageViewer {...viewerProps({ initialPage: 4, artist: "tatsuwaipu", bookmark: { bookmarked: false, onToggle } })} />);

    expect(position()).toBe("4 / 6");
    expect(document.querySelector(".asset-viewer__title strong")).toHaveTextContent("Remote");
    expect(screen.getByText("tatsuwaipu · K-Hentai")).toBeVisible();
    for (const name of ["뒤로", "두 쪽 보기", "페이지 목록", "읽기 설정", "망가 뷰어 닫기"]) expect(screen.getByRole("button", { name })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "북마크" }));
    expect(onToggle).toHaveBeenCalledOnce();
    unmount();

    render(<PageViewer {...viewerProps()} />);
    expect(screen.queryByRole("button", { name: "북마크" })).not.toBeInTheDocument();
    expect(screen.getByText("K-Hentai")).toBeVisible();
  });

  it("keeps page progress and navigation without a bottom thumbnail strip", async () => {
    const onPageChange = vi.fn();
    render(<PageViewer {...viewerProps({ onPageChange })} />);

    fireEvent.change(screen.getByRole("slider", { name: "페이지 위치" }), { target: { value: "5" } });
    expect(position()).toBe("5 / 6");
    expect(onPageChange).toHaveBeenLastCalledWith(5);
    expect(document.querySelector(".asset-viewer__filmstrip-button, .manga-reader__strip")).toBeNull();
    fireEvent.change(screen.getByRole("slider", { name: "페이지 위치" }), { target: { value: "2" } });
    expect(position()).toBe("2 / 6");
    await waitFor(() => expect(shownImages()).toEqual(["Remote 2페이지"]));
    expect(screen.getByRole("slider", { name: "페이지 위치" })).toHaveValue("2");
  });

  it("does not render bottom image previews even for a long work", () => {
    render(<PageViewer {...viewerProps({ pageUrls: Array.from({ length: 40 }, (_, index) => `page-${index + 1}`), initialPage: 20 })} />);
    expect(document.querySelector(".manga-reader__bottom img")).toBeNull();
    expect(screen.getByRole("slider", { name: "페이지 위치" })).toHaveValue("20");
  });

  it("fades the bars after idle time and brings them back on pointer movement or a key", () => {
    vi.useFakeTimers();
    try {
      render(<PageViewer {...viewerProps()} />);
      const reader = document.querySelector<HTMLElement>(".manga-reader")!;
      expect(reader).toHaveAttribute("data-chrome-visible", "true");

      act(() => { vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS); });
      expect(reader).toHaveAttribute("data-chrome-visible", "false");
      expect(reader).toHaveClass("asset-viewer--chrome-hidden");

      fireEvent.pointerMove(reader);
      expect(reader).toHaveAttribute("data-chrome-visible", "true");
      act(() => { vi.advanceTimersByTime(VIEWER_CHROME_IDLE_MS); });
      expect(reader).toHaveAttribute("data-chrome-visible", "false");

      fireEvent.keyDown(reader, { key: "ArrowRight" });
      expect(reader).toHaveAttribute("data-chrome-visible", "true");
      expect(position()).toBe("2 / 6");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a page-shaped placeholder while a page loads and keeps the previous page until the next is ready", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(200);
    const user = userEvent.setup();
    render(<PageViewer {...viewerProps()} />);

    const first = screen.getByRole("img", { name: "Remote 1페이지" });
    expect(screen.getByRole("status", { name: "불러오는 중" })).toBeInTheDocument();
    expect(first).toHaveStyle({ opacity: "0" });
    expect(first.closest(".manga-reader__page")).toHaveStyle({ "--reader-page-ratio": "0.7" });

    fireEvent.load(first);
    expect(screen.queryByRole("status", { name: "불러오는 중" })).not.toBeInTheDocument();
    expect(first).not.toHaveStyle({ opacity: "0" });
    expect(first.closest(".manga-reader__page")).toHaveStyle({ "--reader-page-ratio": "0.5" });

    await user.keyboard("{ArrowRight}");
    // Page 1 stays painted on top; page 2 waits in the hidden buffer with a placeholder of the known shape.
    expect(shownImages()).toEqual(["Remote 1페이지"]);
    const active = document.querySelector('[data-reader-buffer="active"]')!;
    expect(active.querySelector(".manga-reader__placeholder")).toBeNull();
    const pending = document.querySelector('[data-reader-buffer="pending"]')!;
    expect(pending.querySelector(".manga-reader__placeholder")).not.toBeNull();
    expect(pending.querySelector(".manga-reader__page")).toHaveStyle({ "--reader-page-ratio": "0.5" });
  });
});
