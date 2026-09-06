import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

afterEach(cleanup);
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
