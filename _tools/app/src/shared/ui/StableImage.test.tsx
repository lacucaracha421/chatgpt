import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StableImage } from "./StableImage";

afterEach(cleanup);

it("returns to the already loaded A image after A to B to A without another load event", async () => {
  const { container, rerender } = render(<StableImage src="/a" alt="A" />);
  fireEvent.load(screen.getByRole("img"));
  rerender(<StableImage src="/b" alt="B" />);
  fireEvent.load(container.querySelector('img[src="/b"]')!);
  expect(screen.getByRole("img")).toHaveAttribute("src", "/b");
  rerender(<StableImage src="/a" alt="A" />);
  expect(screen.getByRole("img")).toHaveAttribute("src", "/a");
});

it("does not promote B when its decode completes after returning to A", async () => {
  const { container, rerender } = render(<StableImage src="/a" alt="A" />);
  fireEvent.load(screen.getByRole("img"));
  rerender(<StableImage src="/b" alt="B" />);
  let finish!: () => void;
  const b = container.querySelector<HTMLImageElement>('img[src="/b"]')!;
  b.decode = () => new Promise<void>(resolve => { finish = resolve; });
  fireEvent.load(b);
  rerender(<StableImage src="/a" alt="A" />);
  await act(async () => finish());
  expect(screen.getByRole("img")).toHaveAttribute("src", "/a");
});
