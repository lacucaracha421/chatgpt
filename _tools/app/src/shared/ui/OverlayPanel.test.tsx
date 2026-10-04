import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { OverlayPanel } from "./OverlayPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("closes only the panel on Escape and returns focus to its opener", async () => {
  vi.useFakeTimers();
  const parentEscape = vi.fn();

  function Harness() {
    const [open, setOpen] = useState(false);
    return <div onKeyDown={(event) => { if (event.key === "Escape") parentEscape(); }}>
      <button type="button" onClick={() => setOpen(true)}>정보 열기</button>
      <OverlayPanel open={open} title="정보" ariaLabel="자산 정보" onOpenChange={setOpen}>
        <button type="button">패널 작업</button>
      </OverlayPanel>
    </div>;
  }

  render(<Harness />);
  const opener = screen.getByRole("button", { name: "정보 열기" });
  opener.focus();
  fireEvent.click(opener);
  const panel = screen.getByRole("complementary", { name: "자산 정보" });
  expect(panel).toContainElement(document.activeElement as HTMLElement);

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(parentEscape).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(239));
  expect(screen.getByRole("complementary", { name: "자산 정보" })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));

  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});
