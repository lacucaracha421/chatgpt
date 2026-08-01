import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu } from "./Menu";

function MenuFixture({ onRename = vi.fn() }: { onRename?: () => void }) {
  const contextTarget = useRef<HTMLSpanElement>(null);

  return (
    <>
      <Menu
        label="분류 작업"
        trigger="···"
        contextTarget={contextTarget}
        items={[
          { id: "move", label: "이동", onSelect: vi.fn() },
          { id: "rename", label: "이름 변경", onSelect: onRename },
        ]}
      />
      <span ref={contextTarget}>블루 아카이브</span>
      <button type="button">Outside</button>
    </>
  );
}

afterEach(() => {
  cleanup();
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

  it("dismisses on an outside click and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);

    await user.click(screen.getByRole("button", { name: "분류 작업" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "분류 작업" })).toHaveFocus();
  });
});
