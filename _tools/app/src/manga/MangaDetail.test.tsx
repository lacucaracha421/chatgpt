import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CatalogWorkDetail } from "../library/types";
import { displayDate } from "../shared/displayDate";
import { MangaDetail } from "./MangaDetail";

afterEach(cleanup);
const detail: CatalogWorkDetail = {
  provider: "kHentai", providerWorkId: "3", title: "[작가] 오래된 제독 [Korean]", titleJpn: "古い提督",
  thumbnailUrl: "https://example.com/cover.webp", uploader: "tester", category: 2,
  posted: new Date("2025-09-28T12:00:00+09:00").getTime() / 1_000, updated: null,
  fileCount: 24, fileSize: 12_345, rating: 457, views: 200, bookmarked: false,
  tagGroups: [{ namespace: "artist", values: ["circle artist"] }, { namespace: "character", values: ["teitoku"] },
    { namespace: "language", values: ["korean"] }, { namespace: "female", values: ["tag_name"], labels: { tag_name: "태그" } }],
};
const props = { detail, bookmarkPending: false, reading: false, editionCount: 0, editions: [], editionsLoading: false,
  editionsError: false, hasMoreEditions: false, onBookmark: vi.fn(), onRead: vi.fn(), onTagSearch: vi.fn(), onEdition: vi.fn(), onMoreEditions: vi.fn() };

it("shows compact metadata, grouped tag faces and collapsed extra information, without a dialog or first pages", async () => {
  const onTagSearch = vi.fn();
  const onRead = vi.fn();
  const { container } = render(<MangaDetail {...props} onTagSearch={onTagSearch} onRead={onRead} />);
  expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute("aria-description", detail.title);
  const summary = container.querySelector<HTMLElement>(".manga-detail__summary")!;
  expect(within(summary).getByText(/circle artist · .* · 24쪽/)).toBeInTheDocument();
  expect(within(summary).getByText(`한국어 · ${displayDate(detail.posted! * 1_000)}`)).toBeInTheDocument();
  expect(screen.getByText("여성").tagName).toBe("DT");
  expect(screen.getByRole("button", { name: "female:tag_name 검색" })).toHaveTextContent("태그");
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("앞 페이지")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "닫기" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "판본" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("추가 정보"));
  expect(screen.getByText("tester")).toBeVisible();
  expect(screen.getByText("4.57")).toBeVisible();
  expect(screen.queryByText("수정일")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "character:teitoku 검색" }));
  expect(onTagSearch).toHaveBeenCalledWith("character:teitoku");
  await userEvent.click(screen.getByRole("button", { name: "읽기" }));
  expect(onRead).toHaveBeenCalledOnce();
});

it("keeps busy read/bookmark buttons in place and masks every cover in privacy mode", async () => {
  const { rerender, container } = render(<MangaDetail {...props} />);
  const read = screen.getByRole("button", { name: "읽기" });
  const bookmark = screen.getByRole("button", { name: "북마크" });
  const edition = { ...detail, titleJpn: null, artists: [], series: [], posted: 1, language: "korean" };
  rerender(<MangaDetail {...props} detail={{ ...detail, bookmarked: true }} reading bookmarkPending privacyMode editionCount={2} editions={[edition]} />);
  expect(screen.getByRole("button", { name: "읽기" })).toBe(read);
  expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
  expect(read).toBeDisabled();
  expect(read).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "북마크 해제" })).toBe(bookmark);
  expect(bookmark).toBeDisabled();
  expect(bookmark).toHaveAttribute("aria-pressed", "true");
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getAllByLabelText("비공개 모드")).toHaveLength(2);
  expect(screen.getByText("24p · 한국어")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: `${detail.title} 판본 열기` })).toHaveAttribute("aria-pressed", "true");
});

it("resets extra information on an edition change and routes edition and bookmark actions", async () => {
  const onEdition = vi.fn();
  const onBookmark = vi.fn();
  const edition = { ...detail, titleJpn: null, artists: [], series: [], posted: 1, providerWorkId: "4", language: "japanese" };
  const { rerender, container } = render(<MangaDetail {...props} editionCount={2} editions={[edition]} onEdition={onEdition} onBookmark={onBookmark} />);
  await userEvent.click(screen.getByRole("button", { name: `${edition.title} 판본 열기` }));
  expect(onEdition).toHaveBeenCalledWith(edition);
  await userEvent.click(screen.getByRole("button", { name: "북마크" }));
  expect(onBookmark).toHaveBeenCalledWith(true);
  await userEvent.click(screen.getByText("추가 정보"));
  expect(container.querySelector("details")).toHaveAttribute("open");
  rerender(<MangaDetail {...props} detail={{ ...detail, providerWorkId: "4" }} />);
  expect(container.querySelector("details")).not.toHaveAttribute("open");
});
