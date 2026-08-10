import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ViewToolbar } from "./ViewToolbar";

afterEach(cleanup);

describe("ViewToolbar", () => {
  it("renders the title with a drag region", () => {
    const { container } = render(<ViewToolbar title="망가" />);
    const header = container.querySelector(".view-toolbar")!;
    expect(header).toHaveAttribute("data-tauri-drag-region");
    expect(container.querySelector(".view-toolbar h2")).toHaveAttribute("data-tauri-drag-region");
    expect(screen.getByRole("heading", { name: "망가" })).toBeInTheDocument();
  });

  it("places children on the left and actions on the right", () => {
    render(<ViewToolbar title="T" actions={<button type="button">새로고침</button>}>좌측 내용</ViewToolbar>);
    expect(screen.getByText("좌측 내용")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeInTheDocument();
  });

  it("always includes the window controls", () => {
    render(<ViewToolbar title="T" />);
    expect(screen.getByRole("button", { name: "창 최소화" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
  });

  it("exposes the toolbar role with the given label", () => {
    render(<ViewToolbar title="T" ariaLabel="자산 도구" />);
    expect(screen.getByRole("toolbar", { name: "자산 도구" })).toBeInTheDocument();
  });
});
