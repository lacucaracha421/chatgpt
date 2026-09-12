import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DragLayer } from "./DragLayer";

describe("DragLayer", () => {
  it("describes asset drops as additive folder assignment", () => {
    render(<DragLayer state={{ phase: "dragging", payload: { kind: "assets", assetIds: ["asset-1"] }, x: 10, y: 20 }} />);

    expect(screen.getByText("1개 자산 · 폴더에 추가")).toBeInTheDocument();
  });
});
