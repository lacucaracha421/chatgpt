import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CaseFacts } from "../case/CollectionCase";
import { withProductCodeCopy } from "./ProductCodeCopy";

afterEach(() => { cleanup(); vi.useRealTimers(); });
let onCopy = vi.fn<(code: string) => Promise<unknown> | void>();
const rows = withProductCodeCopy([["품번", "CAWB-040"], ["메이커", "kawaii"]], "CAWB-040", code => onCopy(code));

it("puts the copy icon beside the 품번 value and shows copied in place only after the copy lands", async () => {
  vi.useFakeTimers();
  onCopy = vi.fn().mockResolvedValue(undefined);
  render(<CaseFacts rows={rows} />);
  const button = screen.getByRole("button", { name: "품번 복사" });
  expect(button.closest("dd")).toHaveTextContent("CAWB-040");
  expect(screen.getAllByRole("button")).toHaveLength(1);
  const glyph = button.innerHTML;
  await act(async () => { fireEvent.click(button); });
  expect(onCopy).toHaveBeenCalledWith("CAWB-040");
  expect(button.innerHTML).not.toBe(glyph);
  await act(async () => { vi.advanceTimersByTime(1_500); });
  expect(button.innerHTML).toBe(glyph);
});

it("keeps the copy icon when the copy fails", async () => {
  onCopy = vi.fn().mockRejectedValue(new Error("denied"));
  render(<CaseFacts rows={rows} />);
  const button = screen.getByRole("button", { name: "품번 복사" });
  const glyph = button.innerHTML;
  await act(async () => { fireEvent.click(button); });
  expect(onCopy).toHaveBeenCalled();
  expect(button.innerHTML).toBe(glyph);
});
