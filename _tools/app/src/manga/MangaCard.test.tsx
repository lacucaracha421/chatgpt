import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { MangaCard, MangaSkeletonGrid } from "./MangaCard";
import { MangaSourceControl } from "./MangaToolbar";

afterEach(cleanup);
const props = { title: "한 줄 제목", artist: "", coverUrl: null, pageCount: 76, onOpen: vi.fn() };

it("keeps the painted cover and its opacity through opening, selection and deselection", () => {
  const base = readFileSync("src/styles/shared-base.css", "utf8");
  const css = readFileSync("src/manga/manga.css", "utf8");
  const style = document.createElement("style");
  style.textContent = `${base.match(/button:disabled,[\s\S]*?\}/)![0]}\n${css.match(/\.manga-card__body:disabled\s*\{[^}]*\}/)![0]}`;
  document.head.append(style);
  try {
    const cardProps = { ...props, coverUrl: "https://example.com/cover.jpg" };
    const { container, rerender } = render(<MangaCard {...cardProps} selected={false} />);
    const card = container.querySelector("article");
    const button = screen.getByRole("button");
    const image = screen.getByAltText(`${props.title} 표지`);
    fireEvent.load(image);
    for (const state of [{ opening: true, selected: false }, { opening: false, selected: true }, { opening: false, selected: false }]) {
      rerender(<MangaCard {...cardProps} {...state} />);
      expect(container.querySelector("article")).toBe(card);
      expect(screen.getByAltText(`${props.title} 표지`)).toBe(image);
      expect(image).toHaveAttribute("src", cardProps.coverUrl);
      expect(image).toBeVisible();
      expect(getComputedStyle(button).opacity || "1").toBe("1");
    }
  } finally { style.remove(); }
});

it("reserves two title lines and uses a separate artist line and page badge", () => {
  const { container, rerender } = render(<MangaCard {...props} />);
  expect(screen.getByText("한 줄 제목")).toHaveClass("manga-card__title");
  expect(screen.getByText("작가 미상")).toHaveClass("manga-card__artist");
  expect(screen.getByText("76p")).toHaveClass("ui-badge--scrim", "manga-card__pages");
  expect(container.querySelector(".manga-card__frame")).toContainElement(screen.getByText("76p"));
  expect(container.querySelector('[class*="progress"]')).toBeNull();
  expect(container.querySelector(".manga-card__bookmark")).toBeNull();
  const css = readFileSync("src/manga/manga.css", "utf8");
  expect(css).toMatch(/\.manga-card__title\s*\{[^}]*height: 2\.7em;[^}]*line-height: 1\.35;[^}]*-webkit-line-clamp: 2;/);
  expect(css).toMatch(/\.manga-card__frame\s*\{[^}]*aspect-ratio: 148 \/ 208;/);
  rerender(<MangaCard {...props} title="두 줄보다 훨씬 긴 제목을 가진 작품" artist="작가" />);
  expect(screen.getByText("작가")).toHaveClass("manga-card__artist");
});

it("keeps bookmark pending state separate from opening", async () => {
  const onOpen = vi.fn();
  const onBookmark = vi.fn();
  const { rerender } = render(<MangaCard {...props} onOpen={onOpen} onBookmark={onBookmark} bookmarked bookmarkPending />);
  const bookmark = screen.getByRole("button", { name: "한 줄 제목 북마크 해제" });
  expect(bookmark).toBeDisabled();
  expect(bookmark).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(bookmark);
  expect(onBookmark).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "한 줄 제목 상세 보기" }));
  expect(onOpen).toHaveBeenCalledOnce();
  rerender(<MangaCard {...props} onBookmark={onBookmark} />);
  await userEvent.click(screen.getByRole("button", { name: "한 줄 제목 북마크" }));
  expect(onBookmark).toHaveBeenCalledOnce();
});

it("uses content-shaped shared skeletons", () => {
  const { container } = render(<MangaSkeletonGrid />);
  expect(container.querySelectorAll(".manga-card--skeleton")).toHaveLength(12);
  expect(container.querySelectorAll(".manga-card__frame.ui-skeleton")).toHaveLength(12);
  expect(container.querySelectorAll(".manga-card__title.ui-skeleton")).toHaveLength(12);
});

it("uses the shared segmented switch with known counts and keyboard access", async () => {
  const onChange = vi.fn();
  const { rerender } = render(<MangaSourceControl value="all" onChange={onChange} localCount={30} />);
  expect(screen.getByRole("radiogroup", { name: "망가 출처" })).toHaveClass("ui-segmented");
  expect(screen.getByRole("radio", { name: "카탈로그" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: "북마크" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "로컬" })).toBeInTheDocument();
  screen.getByRole("radio", { name: "카탈로그" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenLastCalledWith("bookmarked");
  rerender(<MangaSourceControl value="bookmarked" onChange={onChange} bookmarkCount={280} />);
  expect(screen.getByRole("radio", { name: "북마크" })).toHaveAttribute("aria-checked", "true");
});

it("masks a local manga card with only the NSFW filter enabled", () => {
  const { container } = render(<PrivacyProvider privacyMode={false} nsfwFilter setPrivacyMode={vi.fn()}><MangaCard {...props} coverUrl="https://example.com/cover.jpg" /></PrivacyProvider>);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[src]")).toBeNull();
  expect(container.querySelector(".privacy-mask")).toBeVisible();
});
