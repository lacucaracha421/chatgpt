import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageViewer } from "./PageViewer";

afterEach(cleanup);

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
});
