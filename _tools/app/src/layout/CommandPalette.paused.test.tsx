import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

afterEach(cleanup);

it("keeps normal name search and ignores the scene shortcut while paused", async () => {
  const run = vi.fn(), open = vi.fn();
  const source = { status: vi.fn(), prewarm: vi.fn(), search: vi.fn() };
  render(<CommandPalette open onClose={vi.fn()} context={{ tab: "assets" }}
    entries={[{ id: "folder", group: "place", label: "눈 내리는 폴더", icon: null, run }]}
    descriptionSearch={{ source, open }} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "눈 내리는" } });
  expect(screen.queryByText(/장면 찾기|아직 준비 중/)).toBeNull();
  expect(screen.getByRole("option")).toHaveTextContent("눈 내리는 폴더");
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(open).not.toHaveBeenCalled();
  expect(source.status).not.toHaveBeenCalled();
  expect(source.prewarm).not.toHaveBeenCalled();
  expect(source.search).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledOnce();
});
