import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogWorkDetail } from "../library/types";
import { OnlineCatalogDetailDialog } from "./OnlineCatalogDetailDialog";

afterEach(cleanup);

const detail: CatalogWorkDetail = {
  id: 3,
  title: "오래된 제독",
  titleJpn: "古い提督",
  thumbnailUrl: "https://ehgt.org/w/00/003/work.webp",
  uploader: "tester",
  category: 2,
  posted: 1_700_000_000,
  updated: null,
  fileCount: 24,
  fileSize: 12_345,
  rating: 457,
  views: 200,
  bookmarked: false,
  tagGroups: [
    { namespace: "artist", values: ["circle artist"] },
    { namespace: "series", values: ["fleet saga"] },
    { namespace: "character", values: ["teitoku"] },
    { namespace: "language", values: ["korean"] },
  ],
};

describe("OnlineCatalogDetailDialog", () => {
  it("shows metadata and routes tag and resume actions", async () => {
    const onTagSearch = vi.fn();
    const onRead = vi.fn();
    render(<OnlineCatalogDetailDialog
      detail={detail}
      progress={{ provider: "kHentai", workId: "3", lastPage: 7, pageCount: 24, lastReadAt: "" }}
      bookmarkPending={false}
      reading={false}
      onBookmark={vi.fn()}
      onTagSearch={onTagSearch}
      onRead={onRead}
      onClose={vi.fn()}
    />);

    expect(screen.getByText("오래된 제독")).toBeVisible();
    expect(screen.getByText("tester")).toBeVisible();
    const summary = screen.getByRole("dialog")
      .querySelector<HTMLElement>(".online-catalog-detail__summary")!;
    expect(within(summary).getByText("circle artist")).toBeVisible();
    expect(within(summary).getByText("fleet saga")).toBeVisible();
    expect(within(summary).getByText("korean")).toBeVisible();
    expect(screen.getByText("4.57")).toBeVisible();
    expect(screen.queryByText("수정일")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "character:teitoku 검색" }));
    expect(onTagSearch).toHaveBeenCalledWith("character:teitoku");

    await userEvent.click(screen.getByRole("button", { name: "이어 읽기" }));
    expect(onRead).toHaveBeenCalledOnce();
  });
});
