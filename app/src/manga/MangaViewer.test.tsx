import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaViewer } from "./MangaViewer";

afterEach(cleanup);

describe("MangaViewer", () => {
  it("shows the title and page progress", () => {
    render(<MangaViewer seriesId="s1" title="Batsu Kano" pageCount={60} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Batsu Kano" })).toBeInTheDocument();
    expect(screen.getByText("1 / 60")).toBeVisible();
  });

  it("moves to the next page with the right arrow", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" title="T" pageCount={60} onClose={vi.fn()} />);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2 / 60")).toBeVisible();
  });

  it("moves to the previous page with the left arrow", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" title="T" pageCount={60} onClose={vi.fn()} />);
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("2 / 60")).toBeVisible();
  });

  it("stops at the first and last page", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" title="T" pageCount={2} onClose={vi.fn()} />);
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("1 / 2")).toBeVisible();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2 / 2")).toBeVisible();
  });

  it("closes with the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MangaViewer seriesId="s1" title="T" pageCount={60} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
