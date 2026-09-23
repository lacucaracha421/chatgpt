import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CharacterGroups } from "./CharacterGroups";
import { fixtureTarget } from "./characterFixtures";

afterEach(cleanup);
const members = [fixtureTarget("a", "A"), fixtureTarget("b", "B"), fixtureTarget("c", "C")];
const groups = [{ id: "group", name: "그룹 이름", revision: 1, targetIds: ["a", "b"] }];
const children = () => null;

it("counts every series character including members inside groups", () => {
  render(<CharacterGroups seriesId="series" members={members} groups={groups}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "그룹 1 · 캐릭터 3" })).toBeVisible();
});

it("omits a zero group count and counts ordinary folders separately", () => {
  const { rerender } = render(<CharacterGroups seriesId="series" members={members} groups={[]}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 3" })).toBeVisible();
  rerender(<CharacterGroups seriesId="series" members={members} groups={groups} folderCards={[<div key="folder">폴더</div>, null]}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "그룹 1 · 캐릭터 3 · 폴더 1" })).toBeVisible();
});

it("preserves the group heading and its member count", () => {
  render(<CharacterGroups seriesId="series" members={members} groups={groups} activeGroupId="group">{children}</CharacterGroups>);
  const heading = screen.getByRole("heading", { name: "그룹 · 그룹 이름" });
  expect(heading.querySelector("small")).toHaveTextContent("2");
  expect(screen.queryByText("캐릭터 3")).not.toBeInTheDocument();
});
