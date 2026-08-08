import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { DropOverlay } from "./DropOverlay";

it("shows the destination and accepted formats while a file is over the window", () => {
  const { rerender } = render(<DropOverlay over={{ x: 10, y: 20 }} destinationName="게임" />);
  expect(screen.getByRole("status")).toHaveTextContent("게임에 저장");
  expect(screen.getByRole("status")).toHaveTextContent("JPEG · PNG · GIF · WebP");
  rerender(<DropOverlay over={null} destinationName="미분류함" />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
