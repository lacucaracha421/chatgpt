import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import "../../styles/tokens.css";
import "../../styles/global.css";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

afterEach(cleanup);

function DialogFixture() {
  const [open, setOpen] = useState(false);
  return <>
    <Button onClick={() => setOpen(true)}>열기</Button>
    <Dialog open={open} title="확인" onClose={() => setOpen(false)}>
      <Button onClick={() => setOpen(false)}>닫기</Button>
    </Dialog>
  </>;
}

function layerOf(element: Element) {
  const value = window.getComputedStyle(element).zIndex;
  const token = value.match(/^var\((--[^)]+)\)$/)?.[1];
  return Number(token ? window.getComputedStyle(document.documentElement).getPropertyValue(token) : value);
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

it("layers shared dialog content above its overlay and application content", async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);
  await user.click(screen.getByRole("button", { name: "열기" }));

  const dialog = screen.getByRole("dialog");
  const overlay = document.querySelector<HTMLElement>(".ui-dialog__overlay");
  expect(overlay).not.toBeNull();

  const overlayLayer = layerOf(overlay!);
  const dialogLayer = layerOf(dialog);
  const floatingMenuLayer = Number(window.getComputedStyle(document.documentElement).getPropertyValue("--z-floating-menu"));

  expect(overlayLayer).toBeGreaterThan(1);
  expect(dialogLayer).toBeGreaterThan(overlayLayer);
  expect(floatingMenuLayer).toBeGreaterThan(dialogLayer);
});
