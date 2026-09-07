import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

afterEach(cleanup);
it("places Notes immediately below Revisit and navigates to the notes area", async () => {
  const onNavigate=vi.fn();
  render(<WorkspaceNavigation view={{kind:"notes"}} collectionType="manga" width={208} onWidthChange={vi.fn()} onNavigate={onNavigate} assetNavigation={null} reviewCount={0} trashCount={0}/>);
  const notes=screen.getByRole("button",{name:"메모"});
  expect(screen.getByRole("button",{name:"다시보기"}).nextElementSibling).toBe(notes);
  expect(notes).toHaveAttribute("aria-current","page");
  await userEvent.click(notes);expect(onNavigate).toHaveBeenCalledWith({kind:"notes"});
});
it("shows cloud problems only when actionable and opens cloud settings", async () => {
  const onNavigate = vi.fn();
  const props = { view: { kind: "statistics" as const }, collectionType: "manga" as const, width: 208,
    onWidthChange: vi.fn(), onNavigate, assetNavigation: null, reviewCount: 0, trashCount: 0 };
  const { rerender } = render(<WorkspaceNavigation {...props} />);
  expect(screen.queryByRole("button", { name: /동기화 문제/ })).not.toBeInTheDocument();
  rerender(<WorkspaceNavigation {...props} cloudProblemCount={3} />);
  await userEvent.click(screen.getByRole("button", { name: "동기화 문제 3개" }));
  expect(onNavigate).toHaveBeenCalledWith({ kind: "settings", section: "cloud" });
});
