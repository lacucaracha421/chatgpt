import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BackNavigationProvider, useBackHandler } from "./BackNavigation";

afterEach(cleanup);

function Handler({ priority, onBack }: { priority: number; onBack: () => boolean }) {
  useBackHandler(onBack, priority);
  return null;
}

it("handles only the highest meaningful back layer", () => {
  const view = vi.fn(() => true);
  const detail = vi.fn(() => true);
  render(<BackNavigationProvider><Handler priority={0} onBack={view} /><Handler priority={50} onBack={detail} /></BackNavigationProvider>);

  fireEvent.keyDown(window, { key: "Escape" });

  expect(detail).toHaveBeenCalledOnce();
  expect(view).not.toHaveBeenCalled();
});

it("falls through handlers with no meaningful previous state and leaves editable Escape alone", () => {
  const root = vi.fn(() => false);
  render(<BackNavigationProvider><Handler priority={0} onBack={root} /><input aria-label="검색" /></BackNavigationProvider>);

  fireEvent.keyDown(screen.getByRole("textbox", { name: "검색" }), { key: "Escape" });
  expect(root).not.toHaveBeenCalled();

  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  expect(root).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(false);
});
