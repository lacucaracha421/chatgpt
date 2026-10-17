import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RecentFolders } from "./RecentFolderChips";
import { recentFolderCatalog, type RecentFoldersState } from "./recentFolders";

const folders = [...recentFolderCatalog(Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: i < 2 ? "풍경" : `폴더 ${i}`, parentId: i < 2 ? String(i + 2) : null, kind: "tag", iconKey: null, colorKey: null })), [], []).values()];
const state = (): RecentFoldersState => ({ folders, currentId: "0", open: vi.fn(), record: vi.fn(), remove: vi.fn(), clear: vi.fn() });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// jsdom has no layout: give each chip 100px and the bar `room` pixels.
function layout(room: () => number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.recentId) {
      const left = Number(this.dataset.recentId) * 100;
      return { left, right: left + 100, width: 100, top: 0, bottom: 28, height: 28, x: left, y: 0, toJSON() {} };
    }
    const width = room();
    return { left: 0, right: width, width, top: 0, bottom: 28, height: 28, x: 0, y: 0, toJSON() {} };
  });
}

it("shows five stable chips, disambiguates duplicate names and opens all eight from the shared menu", async () => {
  const history = state();
  layout(() => 2000);
  render(<RecentFolders state={history} />);
  const group = screen.getByRole("group", { name: "최근 폴더" });
  expect(within(group).getAllByRole("button")).toHaveLength(6);
  expect(screen.getByLabelText("숨겨진 폴더 3개")).toBeVisible();
  const current = within(group).getByRole("button", { name: /폴더 2 › ?풍경/ });
  expect(current).toHaveAccessibleDescription("폴더 2 › 풍경");
  expect(current).toHaveAttribute("aria-current", "page");
  await userEvent.click(current);
  expect(history.open).toHaveBeenCalledWith(folders[0]);
  await userEvent.click(within(group).getByRole("button", { name: "최근 폴더" }));
  const menu = screen.getByRole("menu");
  expect(within(menu).getAllByRole("menuitem")).toHaveLength(9);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /^폴더 7 ?폴더 7$/ }));
  expect(history.open).toHaveBeenLastCalledWith(folders[7]);
});

it("drops chips from the end as space shrinks and counts every hidden entry", () => {
  const history = state();
  let room = 250;
  layout(() => room);
  const { rerender } = render(<RecentFolders state={history} />);
  expect(screen.getByLabelText("숨겨진 폴더 6개")).toBeVisible();
  expect(screen.queryByRole("button", { name: "폴더 2" })).not.toBeInTheDocument();
  room = 0;
  rerender(<RecentFolders state={{ ...history, folders: [...history.folders] }} />);
  expect(screen.getByLabelText("숨겨진 폴더 8개")).toBeVisible();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("removes one chip through its context menu and clears the list through the clock menu", async () => {
  const history = state();
  layout(() => 2000);
  const { rerender } = render(<RecentFolders state={history} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: /폴더 2 › ?풍경/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: "최근에서 빼기" }));
  expect(history.remove).toHaveBeenCalledWith("0");
  await userEvent.click(screen.getByRole("button", { name: "최근 폴더" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "최근 목록 비우기" }));
  expect(history.clear).toHaveBeenCalledOnce();
  rerender(<RecentFolders state={{ ...history, folders: [] }} />);
  expect(screen.queryByRole("button", { name: "최근 폴더" })).not.toBeInTheDocument();
});
