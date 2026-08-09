import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

it("opens from its wrapped target and runs the selected action", async () => {
  const user = userEvent.setup();
  const rename = vi.fn();
  render(
    <ContextMenu items={[{ id: "rename", label: "이름 변경", onSelect: rename }]}>
      <button type="button">블루 아카이브</button>
    </ContextMenu>,
  );

  fireEvent.contextMenu(screen.getByRole("button", { name: "블루 아카이브" }));
  await user.click(screen.getByRole("menuitem", { name: "이름 변경" }));

  expect(rename).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
