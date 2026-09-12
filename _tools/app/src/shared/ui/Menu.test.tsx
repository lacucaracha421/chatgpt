import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Menu } from "./Menu";

function MenuFixture({
  items = [
    { id: "move", label: "이동", onSelect: vi.fn() },
    { id: "rename", label: "이름 변경", onSelect: vi.fn() },
  ],
  onMove = vi.fn(),
  onRename = vi.fn(),
}: {
  items?: ComponentProps<typeof Menu>["items"];
  onMove?: () => void;
  onRename?: () => void;
}) {
  return (
    <>
      <Menu
        label="분류 작업"
        trigger="···"
        items={items.map((item) => item.id === "rename" ? { ...item, onSelect: onRename } : item.id === "move" ? { ...item, onSelect: onMove } : item)}
      />
      <button type="button">Outside</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Menu", () => {
  it("opens from its trigger, focuses the first item, and activates it from the keyboard", async () => {
    const user = userEvent.setup();
    const move = vi.fn();
    render(<MenuFixture onMove={move} />);

    const trigger = screen.getByRole("button", { name: "분류 작업" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeVisible();
    const moveItem = screen.getByRole("menuitem", { name: "이동" });
    expect(moveItem.tagName).toBe("BUTTON");
    expect(moveItem).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(move).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses on an outside click and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);

    await user.click(screen.getByRole("button", { name: "분류 작업" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("keeps an all-disabled menu keyboard-dismissible", async () => {
    const user = userEvent.setup();
    render(
      <MenuFixture
        items={[{ id: "blocked", label: "Unavailable", disabled: true, onSelect: vi.fn() }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "분류 작업" }));
    expect(screen.getByRole("menu")).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "분류 작업" })).toHaveFocus();
  });

  it("exposes checkbox items with menuitemcheckbox semantics", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <MenuFixture
        items={[{ id: "cover", label: "표지 단독 보기", checked: true, onSelect }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "분류 작업" }));
    const item = screen.getByRole("menuitemcheckbox", { name: "표지 단독 보기" });
    expect(item).toHaveAttribute("aria-checked", "true");
    await user.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("exposes grouped items as a radio group with the active option checked", async () => {
    const user = userEvent.setup();
    const onNarrow = vi.fn();
    render(
      <MenuFixture
        items={[
          { id: "narrow", label: "좁게", group: "gap", selected: true, onSelect: onNarrow },
          { id: "wide", label: "넓게", group: "gap", selected: false, onSelect: vi.fn() },
          { id: "plain", label: "일반 동작", onSelect: vi.fn() },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "분류 작업" }));
    const narrow = screen.getByRole("menuitemradio", { name: "좁게" });
    expect(narrow).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "넓게" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitem", { name: "일반 동작" })).toBeVisible();
    await user.click(narrow);
    expect(onNarrow).toHaveBeenCalledOnce();
  });
});

describe("Button", () => {
  it("uses a neutral default and retains an explicit primary variant", () => {
    render(
      <>
        <Button>Neutral</Button>
        <Button variant="primary">Primary</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Neutral" })).toHaveClass("ui-button--secondary");
    expect(screen.getByRole("button", { name: "Primary" })).toHaveClass("ui-button--primary");
  });
});
