import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { DropOverlay } from "./DropOverlay";

it("uses a quiet generic instruction with the destination and accepted formats", () => {
  const { rerender } = render(<DropOverlay over={{ x: 10, y: 20 }} destinationName="게임" />);
  expect(screen.getByRole("status")).toHaveTextContent("여기에 놓아 추가");
  expect(screen.getByRole("status")).toHaveTextContent("게임");
  expect(screen.getByRole("status")).toHaveTextContent("이미지와 영상 파일");
  rerender(<DropOverlay over={null} destinationName="미분류" />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
