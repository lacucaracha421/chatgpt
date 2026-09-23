import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogThumbnail } from "./CatalogThumbnail";
import { PrivacyProvider } from "../privacy/PrivacyContext";

afterEach(cleanup);
const props = { src: "https://example.com/cover.jpg", title: "작품", pageCount: 24, className: "online-catalog-card__cover" };

it("reserves the cover surface while loading, then replaces the cue with the image", () => {
  const { container } = render(<CatalogThumbnail {...props} />);
  const surface = container.firstElementChild;
  expect(screen.getByRole("img", { name: "표지를 불러오는 중" })).toBeVisible();
  expect(surface).toHaveClass("online-catalog-card__cover");
  expect(surface).toHaveAttribute("aria-busy", "true");
  const cover = screen.getByAltText("작품 표지");
  expect(cover).not.toBeVisible();
  fireEvent.load(cover);
  expect(container.firstElementChild).toBe(surface);
  expect(cover).toBeVisible();
  expect(surface).toHaveAttribute("aria-busy", "false");
  expect(screen.queryByLabelText("표지를 불러오는 중")).not.toBeInTheDocument();
});

it("keeps the existing failure state and restarts loading when the source changes", () => {
  const { rerender } = render(<CatalogThumbnail {...props} />);
  fireEvent.error(screen.getByAltText("작품 표지"));
  expect(screen.getByText("24페이지")).toBeVisible();
  expect(screen.queryByLabelText("표지를 불러오는 중")).not.toBeInTheDocument();
  rerender(<CatalogThumbnail {...props} src="https://example.com/next.jpg" />);
  expect(screen.getByLabelText("표지를 불러오는 중")).toBeVisible();
  fireEvent.load(screen.getByAltText("작품 표지"));
  rerender(<CatalogThumbnail {...props} />);
  expect(screen.getByLabelText("표지를 불러오는 중")).toBeVisible();
});

it("does not request a cover in privacy mode and handles absent sources", () => {
  const { container, rerender } = render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><CatalogThumbnail {...props} /></PrivacyProvider>);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.queryByLabelText("표지를 불러오는 중")).not.toBeInTheDocument();
  rerender(<CatalogThumbnail {...props} src={null} />);
  expect(screen.getByText("24페이지")).toBeVisible();
});
