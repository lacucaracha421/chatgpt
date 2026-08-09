import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetViewer } from "./AssetViewer";

beforeEach(() => Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } },
  close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
}));
afterEach(cleanup);

it("uses original media and navigates only inside the loaded order", () => {
  const onActiveIdChange = vi.fn();
  render(<AssetViewer items={[asset("a", "a.gif"), asset("b", "b.png")]} activeId="a" onActiveIdChange={onActiveIdChange} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "a.gif" });

  expect(dialog).toHaveClass("ui-dialog--fullscreen");
  expect(screen.getByRole("img", { name: "a.gif" })).toHaveAttribute("src", "http://lakomics.localhost/asset/a");
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  expect(onActiveIdChange).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(onActiveIdChange).toHaveBeenCalledWith("b");
});

it("supports buttons and Escape without wrapping at the final asset", async () => {
  const user = userEvent.setup();
  const onActiveIdChange = vi.fn();
  const onClose = vi.fn();
  render(<AssetViewer items={[asset("a", "a.gif"), asset("b", "b.png")]} activeId="b" onActiveIdChange={onActiveIdChange} onClose={onClose} />);

  expect(screen.getByRole("button", { name: "다음 자산" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(onActiveIdChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "이전 자산" }));
  expect(onActiveIdChange).toHaveBeenCalledWith("a");
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
});

function asset(id: string, originalName: string): AssetSummary {
  return { id, title: null, originalName, byteSize: 1, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: null };
}
