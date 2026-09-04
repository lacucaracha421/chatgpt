import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_PREFERENCES_KEY } from "../preferences/uiPreferences";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { PageViewer } from "./PageViewer";

afterEach(() => {
  cleanup();
  localStorage.clear();
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
    document.querySelectorAll(".manga-viewer__spread .manga-viewer__page"),
    (element) => element.getAttribute("alt") ?? "",
  ).filter((alt) => alt.endsWith("페이지"));
}

describe("PageViewer", () => {
  it("starts at the restored page and identifies the source", () => {
    render(<PageViewer
      title="Remote"
      pageUrls={["page-1", "page-2", "page-3"]}
      initialPage={2}
      sourceLabel="K-Hentai"
      onPageChange={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(screen.getByText("2 / 3")).toBeVisible();
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
    const nextEdge = document.querySelectorAll<HTMLElement>(".manga-viewer__edge")[1]!;

    await user.click(nextEdge);

    expect(document.activeElement).not.toBe(nextEdge);
    expect(screen.getByText("2 / 2")).toBeVisible();
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
    expect(screen.getByText("1 / 6")).toBeVisible();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2-3 / 6")).toBeVisible();
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("4-5 / 6")).toBeVisible();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("6 / 6")).toBeVisible();
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
    expect(screen.getByText("2-3 / 6")).toBeVisible();
  });

  it("navigates physical edges per direction", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PageViewer {...viewerProps({ initialPage: 2 })} />);
    const edges = () => document.querySelectorAll<HTMLElement>(".manga-viewer__edge");

    await user.click(edges()[0]!);
    expect(screen.getByText("1 / 6")).toBeVisible();
    await user.click(edges()[1]!);
    expect(screen.getByText("2 / 6")).toBeVisible();
    unmount();

    seedReaderPrefs({ mangaReadingDirection: "rtl" });
    render(<PageViewer {...viewerProps({ initialPage: 1 })} />);
    const rtlEdges = () => document.querySelectorAll<HTMLElement>(".manga-viewer__edge");
    await user.click(rtlEdges()[0]!);
    expect(screen.getByText("2 / 6")).toBeVisible();
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
    expect(screen.getByText("2-3 / 6")).toBeVisible();
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
    expect(screen.getByText("4 / 6")).toBeVisible();
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
    expect(screen.getByText("1 / 6")).toBeVisible();
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

  it("masks overview imagery in privacy mode", async () => {
    const user = userEvent.setup();
    render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}>
      <PageViewer {...viewerProps()} />
    </PrivacyProvider>);

    await user.click(screen.getByRole("button", { name: "페이지 목록" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3페이지로 이동" })).toBeVisible();
  });

  it("restores persisted reader preferences on open", async () => {
    seedReaderPrefs({ mangaReadingDirection: "rtl", mangaPageMode: "double" });
    render(<PageViewer {...viewerProps({ initialPage: 2 })} />);

    expect(await screen.findByText("2-3 / 6")).toBeVisible();
    expect(shownImages()).toEqual(["Remote 3페이지", "Remote 2페이지"]);
  });

  it("applies margin and gap preferences to the spread", async () => {
    const user = userEvent.setup();
    render(<PageViewer {...viewerProps()} />);

    await user.click(screen.getByRole("button", { name: "읽기 설정" }));
    await user.click(screen.getByRole("menuitemradio", { name: "여백: 넓게" }));
    await user.click(screen.getByRole("button", { name: "읽기 설정" }));
    await user.click(screen.getByRole("menuitemradio", { name: "페이지 간격: 넓게" }));

    const spread = document.querySelector(".manga-viewer__spread") as HTMLElement;
    expect(spread.style.padding).toBe("48px");
    expect(spread.style.columnGap).toBe("24px");
  });

  it("preloads the previous spread and logical pages ahead in double mode", () => {
    render(<PageViewer {...viewerProps({
      pageUrls: Array.from({ length: 10 }, (_, index) => `page-${index + 1}`),
      initialPage: 2,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "양면 보기" }));

    expect(Array.from(document.querySelectorAll(".manga-viewer__preload"), (image) => image.getAttribute("src")))
      .toEqual(["page-1", "page-4", "page-5", "page-6", "page-7"]);
  });

  it("keeps logical preload order in RTL", () => {
    seedReaderPrefs({ mangaReadingDirection: "rtl" });
    render(<PageViewer {...viewerProps({
      pageUrls: Array.from({ length: 10 }, (_, index) => `page-${index + 1}`),
      initialPage: 2,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "양면 보기" }));

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
});
