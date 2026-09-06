import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GameCase } from "./GameCase";
import { drawGameCase } from "./drawGameCase";

vi.mock("./drawGameCase", () => ({ drawGameCase: vi.fn(() => true) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("draws the shell before delayed artwork and ignores an obsolete source", () => {
  const images: Array<{ naturalWidth: number; onload: (() => void) | null; src: string }> = [];
  vi.stubGlobal("Image", class {
    naturalWidth = 0; onload = null; src = "";
    constructor() { images.push(this); }
  });
  const { container, rerender } = render(<GameCase src="first.jpg" alt="게임 표지" />);
  const canvas = container.querySelector("canvas");
  expect(drawGameCase).toHaveBeenCalledWith(canvas, null, 154);
  const previous = images[0].onload!;
  rerender(<GameCase src="second.jpg" alt="게임 표지" />);
  vi.mocked(drawGameCase).mockClear();
  act(() => { images[0].naturalWidth = 500; previous(); });
  expect(drawGameCase).not.toHaveBeenCalled();
  const latest = images[images.length - 1];
  act(() => { latest.naturalWidth = 500; latest.onload!(); });
  expect(drawGameCase).toHaveBeenCalledWith(canvas, latest, 154);
  expect(container.querySelector(".game-case")).toHaveAttribute("data-ready", "true");
});
