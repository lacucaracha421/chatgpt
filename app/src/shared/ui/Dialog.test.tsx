import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

function DialogFixture() {
  const [open, setOpen] = useState(false);
  return <>
    <Button onClick={() => setOpen(true)}>열기</Button>
    <Dialog open={open} title="확인" onClose={() => setOpen(false)}>
      <Button onClick={() => setOpen(false)}>닫기</Button>
    </Dialog>
  </>;
}

it("shows its title and returns focus to the opener after Escape", async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);
  const opener = screen.getByRole("button", { name: "열기" });

  await user.click(opener);
  expect(screen.getByRole("heading", { name: "확인" })).toBeVisible();
  await user.keyboard("{Escape}");

  expect(screen.queryByRole("heading", { name: "확인" })).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});
