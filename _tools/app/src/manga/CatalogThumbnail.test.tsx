import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogThumbnail } from "./CatalogThumbnail";
import { PrivacyProvider } from "../privacy/PrivacyContext";

afterEach(cleanup);
const props = { src: "https://example.com/cover.jpg", title: "작품", className: "manga-detail__cover" };

it("reserves a quiet surface while loading and on failure", () => {
  const { container } = render(<CatalogThumbnail {...props} />);
  const surface = container.firstElementChild;
  expect(surface).toHaveClass("manga-cover", "manga-detail__cover");
  expect(surface).toHaveAttribute("aria-busy", "true");
  const cover = screen.getByAltText("작품 표지");
  expect(cover).not.toBeVisible();
  fireEvent.load(cover);
  expect(container.firstElementChild).toBe(surface);
  expect(cover).toBeVisible();
  expect(surface).toHaveAttribute("aria-busy", "false");
  fireEvent.error(cover);
  expect(container.firstElementChild).toBe(surface);
  expect(container.querySelector("img")).toBeNull();
});

it("keeps the painted element until the next source loads", async () => {
  const { container, rerender } = render(<CatalogThumbnail {...props} />);
  const painted = screen.getByAltText("작품 표지");
  fireEvent.load(painted);
  rerender(<CatalogThumbnail {...props} src="https://example.com/next.jpg" />);
  expect(painted).toBeVisible();
  expect(painted).toHaveAttribute("src", props.src);
  const next = container.querySelector('[data-stable-image-loading="true"]')!;
  expect(next).not.toBeVisible();
  await act(async () => fireEvent.load(next));
  expect(next).toBeVisible();
  expect(painted).not.toBeVisible();
});

it("requests no cover in privacy mode or for an absent source", () => {
  const { container, rerender } = render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><CatalogThumbnail {...props} /></PrivacyProvider>);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByLabelText("비공개 모드")).toBeVisible();
  rerender(<CatalogThumbnail {...props} src={null} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.firstElementChild).toHaveClass("manga-cover");
});
