import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterGroups } from "./CharacterGroups";
import { fixtureTarget } from "./characterFixtures";

afterEach(cleanup);
const members = [fixtureTarget("a", "A"), fixtureTarget("b", "B"), fixtureTarget("c", "C")];
const groups = [{ id: "group", name: "그룹 이름", revision: 1, targetIds: ["a", "b"] }];
const children = () => null;

it("counts every series character including members inside groups", () => {
  render(<CharacterGroups seriesId="series" members={members} groups={groups}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 3 · 그룹 1" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "그룹 만들기" })).not.toBeInTheDocument();
});

it("puts the owner's quiet action on the count line and opens a group draft on request", () => {
  const { rerender } = render(<CharacterGroups seriesId="series" members={members} groups={groups} headerAccessory={<button>후보 4 확인</button>} groupCreateRequest={3}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 3 · 그룹 1" }).parentElement).toContainElement(screen.getByRole("button", { name: "후보 4 확인" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  rerender(<CharacterGroups seriesId="series" members={members} groups={groups} groupCreateRequest={4}>{children}</CharacterGroups>);
  expect(screen.getByRole("dialog", { name: "캐릭터 그룹 만들기" })).toBeVisible();
});

it("keeps group tiles name-only with members in the accessible description", () => {
  render(<CharacterGroups seriesId="series" members={members} groups={groups}>{children}</CharacterGroups>);
  const tile = screen.getByRole("button", { name: "그룹 이름 그룹 열기" });
  expect(tile).toHaveAttribute("aria-description", "2명 · A · B");
  expect(tile.querySelector("small")).toBeNull();
});

it("omits a zero group count and counts ordinary folders separately", () => {
  const { rerender } = render(<CharacterGroups seriesId="series" members={members} groups={[]}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 3" })).toBeVisible();
  rerender(<CharacterGroups seriesId="series" members={members} groups={groups} folderCards={[<div key="folder">폴더</div>, null]}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 3 · 그룹 1 · 폴더 1" })).toBeVisible();
});

it("starts a group view with its member tiles and no heading or back button", () => {
  render(<CharacterGroups seriesId="series" members={members} groups={groups} activeGroupId="group">{children}</CharacterGroups>);
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "시리즈로" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "그룹 편집" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("그룹 이름 그룹 캐릭터")).toBeInTheDocument();
  expect(screen.queryByText("캐릭터 3")).not.toBeInTheDocument();
});

it("shows a single row of cards per page when asked and pages the rest", async () => {
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {} unobserve() {}
  });
  try {
    const many = Array.from({ length: 5 }, (_, index) => fixtureTarget(`m-${index}`, `캐릭터 ${index}`));
    const view = render(<CharacterGroups seriesId="series" members={many} groups={[]} rows={1}>{page => <>{page.map(member => <button key={member.id}>{member.displayName}</button>)}</>}</CharacterGroups>);
    const grid = view.container.querySelector<HTMLElement>(".series-characters")!;
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 400 });
    act(() => resize());
    expect(grid.style.getPropertyValue("--series-card-rows")).toBe("1");
    expect(within(grid).getAllByRole("button").map(button => button.textContent)).toEqual(["캐릭터 0", "캐릭터 1"]);
    const pages = screen.getByRole("navigation", { name: "캐릭터·폴더 페이지" });
    expect(within(pages).getAllByRole("button")).toHaveLength(3);
    await userEvent.setup().click(within(pages).getByRole("button", { name: "3페이지" }));
    expect(within(grid).getAllByRole("button").map(button => button.textContent)).toEqual(["캐릭터 4"]);
  } finally { vi.unstubAllGlobals(); }
});
