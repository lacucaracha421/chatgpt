import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

afterEach(() => vi.unstubAllGlobals());

it("reveals an icon button description without a permanent label", async () => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const user = userEvent.setup();
  render(<Tooltip content="다시 섞기"><button aria-label="다시 섞기">↻</button></Tooltip>);

  await user.hover(screen.getByRole("button", { name: "다시 섞기" }));

  expect(await screen.findByRole("tooltip")).toHaveTextContent("다시 섞기");
});
