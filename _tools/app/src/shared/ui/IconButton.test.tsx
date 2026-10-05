import { BookmarkIcon, HeartIcon } from "@heroicons/react/24/outline";
import { HeartIcon as HeartSolidIcon } from "@heroicons/react/24/solid";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BookmarkToggle } from "./BookmarkToggle";
import { IconButton } from "./IconButton";
import { PinIcon, PinSolidIcon } from "./PinIcon";

const pop = vi.hoisted(() => ({ popToggle: vi.fn() }));
vi.mock("../motion/togglePop", () => pop);

afterEach(() => { cleanup(); pop.popToggle.mockReset(); });

const Outline = () => <svg data-testid="outline" />;
const Solid = () => <svg data-testid="solid" />;

it("is a plain icon action without a pressed state unless it is a toggle", () => {
  const onClick = vi.fn();
  render(<IconButton label="더보기" icon={Outline} onClick={onClick} />);
  const button = screen.getByRole("button", { name: "더보기" });
  expect(button).toHaveAttribute("type", "button");
  expect(button).not.toHaveAttribute("aria-pressed");
  expect(button).toHaveClass("ui-button", "ui-button--ghost", "ui-button--icon", "ui-icon-button");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
  expect(pop.popToggle).not.toHaveBeenCalled();
});

it("shows the outline glyph off and the solid glyph on, with aria-pressed", () => {
  const { rerender } = render(<IconButton label="고정" icon={Outline} activeIcon={Solid} active={false} onClick={vi.fn()} />);
  const button = screen.getByRole("button", { name: "고정" });
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByTestId("outline")).toBeInTheDocument();
  rerender(<IconButton label="고정" icon={Outline} activeIcon={Solid} active onClick={vi.fn()} />);
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("solid")).toBeInTheDocument();
  expect(screen.queryByTestId("outline")).toBeNull();
});

it("pops only affection toggles, with the state they turn to", () => {
  const onClick = vi.fn();
  render(<>
    <IconButton label="좋아요" tone="heart" pop icon={HeartIcon} activeIcon={HeartSolidIcon} active={false} onClick={onClick} data-toggle-key="a" />
    <IconButton label="고정" icon={PinIcon} activeIcon={PinSolidIcon} active={false} onClick={onClick} />
  </>);
  const heart = screen.getByRole("button", { name: "좋아요" });
  expect(heart).toHaveClass("ui-icon-button--heart");
  expect(heart).toHaveAttribute("data-toggle-key", "a");
  fireEvent.click(heart);
  expect(pop.popToggle).toHaveBeenCalledWith(heart, true);
  fireEvent.click(screen.getByRole("button", { name: "고정" }));
  expect(pop.popToggle).toHaveBeenCalledOnce();
  expect(onClick).toHaveBeenCalledTimes(2);
});

it("builds the bookmark toggle in its cover-corner and inline forms", () => {
  const onClick = vi.fn();
  const { rerender } = render(<BookmarkToggle form="corner" label="작품 북마크" bookmarked={false} onClick={onClick} />);
  const corner = screen.getByRole("button", { name: "작품 북마크" });
  expect(corner).toHaveClass("ui-icon-button", "ui-bookmark-corner");
  expect(corner).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(corner);
  expect(pop.popToggle).toHaveBeenLastCalledWith(corner, true);
  expect(onClick).toHaveBeenCalledOnce();

  rerender(<BookmarkToggle label="북마크 해제" bookmarked onClick={onClick} />);
  const inline = screen.getByRole("button", { name: "북마크 해제" });
  expect(inline).not.toHaveClass("ui-bookmark-corner");
  expect(inline).toHaveAttribute("aria-pressed", "true");
  // The on glyph is the solid bookmark, not the outline one.
  const { container } = render(<BookmarkIcon />);
  expect(inline.querySelector("path")?.getAttribute("d")).not.toBe(container.querySelector("path")?.getAttribute("d"));
  fireEvent.click(inline);
  expect(pop.popToggle).toHaveBeenLastCalledWith(inline, false);
});

it("keeps one shared pressed style: the accent, --color-heart for the heart, and no face", () => {
  const css = readFileSync(resolve(__dirname, "../../styles/controls.css"), "utf8");
  expect(css).toMatch(/\.ui-icon-button\.ui-button\[aria-pressed="true"\] \{ color: var\(--color-accent\); background: transparent; \}/);
  expect(css).toMatch(/\.ui-icon-button--heart\.ui-button\[aria-pressed="true"\],[^{]*\{ color: var\(--color-heart\); \}/);
  expect(css).toMatch(/\.ui-bookmark-corner\.ui-button\[aria-pressed="true"\],[^{]*\{ background: transparent; color: var\(--color-accent\); \}/);
});
