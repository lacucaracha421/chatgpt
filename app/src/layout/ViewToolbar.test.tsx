import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ViewToolbar } from "./ViewToolbar";
import { ChromeTarget, WorkspaceChromeProvider } from "./WorkspaceChrome";

afterEach(cleanup);

describe("ViewToolbar", () => {
  it("moves the contextual toolbar into the shared titlebar without duplicating it", () => {
    const view = (title: string) => <WorkspaceChromeProvider scope={title}>
      <div data-testid="titlebar"><ChromeTarget name="header" /></div>
      <main><ViewToolbar title={title} chrome={{ status: <button>선택 해제</button> }} /></main>
    </WorkspaceChromeProvider>;
    const { container, rerender } = render(view("저장소"));
    expect(screen.getByTestId("titlebar")).toContainElement(screen.getByRole("heading", { name: "저장소" }));
    expect(container.querySelector("main .view-toolbar")).toBeNull();
    expect(screen.getAllByRole("toolbar")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "선택 해제" })).toBeInTheDocument();
    rerender(view("건담"));
    expect(screen.queryByRole("heading", { name: "저장소" })).not.toBeInTheDocument();
    expect(screen.getByTestId("titlebar")).toContainElement(screen.getByRole("heading", { name: "건담" }));
  });
  it("marks the whole bar as a deep native drag region", () => {
    const { container } = render(<ViewToolbar title="망가" />);
    const header = container.querySelector(".view-toolbar")!;
    expect(header).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(container.querySelector(".view-toolbar h2")).not.toHaveAttribute("data-tauri-drag-region");
    expect(screen.getByRole("heading", { name: "망가" })).toBeInTheDocument();
  });

  it("places children on the left and actions on the right", () => {
    const { container } = render(<ViewToolbar title="T" actions={<button type="button">새로고침</button>}>좌측 내용</ViewToolbar>);
    expect(screen.getByText("좌측 내용")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeInTheDocument();
    expect(container.querySelector(".view-toolbar__content")).not.toHaveAttribute("data-tauri-drag-region");
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
