import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import "../../styles/tokens.css";
import "../../styles/global.css";
import { BackNavigationProvider, useBackHandler } from "../navigation/BackNavigation";
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

it("treats a strong horizontal trackpad swipe as back", async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);
  await user.click(screen.getByRole("button", { name: "열기" }));
  const dialog = screen.getByRole("dialog");

  fireEvent.wheel(dialog, { deltaX: 30, deltaY: 0 });
  fireEvent.wheel(dialog, { deltaX: 30, deltaY: 0 });
  expect(screen.queryByRole("heading", { name: "확인" })).toBeInTheDocument();
  fireEvent.wheel(dialog, { deltaX: 30, deltaY: 0 });

  expect(screen.queryByRole("heading", { name: "확인" })).not.toBeInTheDocument();
});

it("ignores vertical scrolling and small horizontal jitter", async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);
  await user.click(screen.getByRole("button", { name: "열기" }));
  const dialog = screen.getByRole("dialog");

  fireEvent.wheel(dialog, { deltaX: 5, deltaY: 200 });
  fireEvent.wheel(dialog, { deltaX: 10, deltaY: 0 });
  fireEvent.wheel(dialog, { deltaX: 10, deltaY: 0 });

  expect(screen.getByRole("heading", { name: "확인" })).toBeVisible();
});

it("prefers the registered back chain over closing directly", async () => {
  const onBack = vi.fn(() => true);
  const onClose = vi.fn();
  function BackFixture() {
    useBackHandler(onBack, 200, true);
    return (
      <Dialog open title="확인" onClose={onClose}>
        <span>내용</span>
      </Dialog>
    );
  }
  render(
    <BackNavigationProvider>
      <BackFixture />
    </BackNavigationProvider>,
  );

  fireEvent.wheel(screen.getByRole("dialog"), { deltaX: 100, deltaY: 0 });

  expect(onBack).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "확인" })).toBeVisible();
});
