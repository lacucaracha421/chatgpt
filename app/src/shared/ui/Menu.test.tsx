import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Menu } from "./Menu";

function MenuFixture({
  items = [
    { id: "move", label: "이동", onSelect: vi.fn() },
    { id: "rename", label: "이름 변경", onSelect: vi.fn() },
  ],
  onRename = vi.fn(),
}: {
  items?: ComponentProps<typeof Menu>["items"];
  onRename?: () => void;
}) {
  const contextTarget = useRef<HTMLSpanElement>(null);

  return (
    <>
      <Menu
        label="분류 작업"
        trigger="···"
        contextTarget={contextTarget}
        items={items.map((item) => item.id === "rename" ? { ...item, onSelect: onRename } : item)}
      />
      <span ref={contextTarget}>블루 아카이브</span>
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
  it("opens from its trigger, moves focus, and activates the focused item", async () => {
    const user = userEvent.setup();
    const rename = vi.fn();
    render(<MenuFixture onRename={rename} />);

    await user.click(screen.getByRole("button", { name: "분류 작업" }));
    expect(screen.getByRole("menu")).toBeVisible();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "이름 변경" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(rename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "분류 작업" })).toHaveFocus();
  });

  it("opens the same menu from the context target and returns focus on Escape", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);

    fireEvent.contextMenu(screen.getByText("블루 아카이브"));
    expect(screen.getByRole("menu")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "분류 작업" })).toHaveFocus();
  });

  it("stays open through the pointer release following a context-menu open", () => {
    render(<MenuFixture />);
    const target = screen.getByText("블루 아카이브");

    fireEvent.contextMenu(target, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(target);

    expect(screen.getByRole("menu")).toBeVisible();
  });

  it("still dismisses when the next pointer release is outside the context target", () => {
    render(<MenuFixture />);

    fireEvent.contextMenu(screen.getByText("블루 아카이브"));
    fireEvent.pointerUp(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("dismisses on an outside click and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);

    await user.click(screen.getByRole("button", { name: "분류 작업" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "분류 작업" })).toHaveFocus();
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

  it("clamps a context menu inside the viewport after measuring it", () => {
    vi.stubGlobal("innerHeight", 200);
    vi.stubGlobal("innerWidth", 300);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const isMenu = this.classList.contains("ui-menu");
      return {
        bottom: isMenu ? 120 : 0,
        height: isMenu ? 120 : 0,
        left: 0,
        right: isMenu ? 200 : 0,
        toJSON: () => ({}),
        top: 0,
        width: isMenu ? 200 : 0,
        x: 0,
        y: 0,
      } as DOMRect;
    });
    render(<MenuFixture />);

    fireEvent.contextMenu(screen.getByText("블루 아카이브"), { clientX: 280, clientY: 190 });

    expect(screen.getByRole("menu")).toHaveStyle({ left: "100px", top: "80px" });
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
