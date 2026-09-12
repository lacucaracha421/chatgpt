import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CompleteCoverViewer, availableCoverStops } from "./CompleteCoverViewer";
import { attachLiveCase } from "./collectibleRuntime";
import type { AvCoverSet } from "../avTypes";
vi.mock("./collectibleRuntime", () => ({ attachLiveCase: vi.fn(() => ({ dispose: vi.fn() })) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const covers: AvCoverSet = { frontId: "f", spineId: "s", backId: "b", revision: "r" };
it("uses only truthful available stops and requires a front", () => {
  expect(availableCoverStops({ ...covers, spineId: null })).toEqual(["front", "back"]);
  expect(availableCoverStops({ ...covers, spineId: null, backId: null })).toEqual(["front"]);
  expect(availableCoverStops({ ...covers, frontId: null })).toEqual([]);
  expect(availableCoverStops(covers, { back: true })).toEqual(["front", "spine"]);
});
it("snaps with keyboard, does not wrap, and opens only the chosen original", async () => {
  const user = userEvent.setup(), close = vi.fn();
  render(<CompleteCoverViewer title="AV" covers={covers} onClose={close} />);
  await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
  expect(screen.getByRole("button", { name: "뒷면" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "원본 보기" }));
  expect(screen.getByRole("img", { name: "뒷면 원본" })).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/b");
  fireEvent.error(screen.getByRole("img", { name: "뒷면 원본" }));
  expect(screen.queryByRole("button", { name: "뒷면" })).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "앞면 원본" })).toBeInTheDocument();
  await user.keyboard("{Escape}"); expect(close).toHaveBeenCalledOnce();
});
it("disposes the live owner on a surface change and close", async () => {
  const dispose = vi.fn(); vi.mocked(attachLiveCase).mockReturnValue({ dispose });
  const user = userEvent.setup(), { unmount } = render(<CompleteCoverViewer title="AV" covers={covers} onClose={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "책등" })); expect(dispose).toHaveBeenCalledOnce();
  unmount(); expect(dispose).toHaveBeenCalledTimes(2);
});
