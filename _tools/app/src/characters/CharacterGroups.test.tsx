import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CharacterGroups } from "./CharacterGroups";
import { fixtureTarget } from "./characterFixtures";

afterEach(cleanup);
const members = [fixtureTarget("a", "A"), fixtureTarget("b", "B"), fixtureTarget("c", "C")];
const groups = [{ id: "group", name: "그룹 이름", revision: 1, targetIds: ["a", "b"] }];
const children = () => null;

it("preserves refreshed manual order in group member tiles and preview descriptions", () => {
  const reordered = [members[1], members[2], members[0]].map((member, folderOrder) => ({ ...member, folderOrder }));
  const renderMembers = (page: typeof members) => <>{page.map(member => <button key={member.id}>{member.displayName}</button>)}</>;
  const view = render(<CharacterGroups seriesId="series" members={reordered} groups={groups}>{renderMembers}</CharacterGroups>);
  expect(screen.getByRole("button", { name: "그룹 이름 그룹 열기" })).toHaveAttribute("aria-description", "2명 · B · A");
  view.rerender(<CharacterGroups seriesId="series" members={reordered} groups={groups} activeGroupId="group">{renderMembers}</CharacterGroups>);
  expect(within(screen.getByLabelText("그룹 이름 그룹 캐릭터")).getAllByRole("button").map(button => button.textContent)).toEqual(["B", "A"]);
});

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
  const { rerender } = render(<CharacterGroups seriesId="series" members={members} groups={groups}>{children}</CharacterGroups>);
  const tile = screen.getByRole("button", { name: "그룹 이름 그룹 열기" });
  expect(tile).toHaveAttribute("aria-description", "2명 · A · B");
  const count = tile.querySelector("small");
  expect(count).toBeEmptyDOMElement();
  expect(count).toHaveAttribute("aria-hidden", "true");
  rerender(<CharacterGroups seriesId="series" members={members} groups={groups} memberCounts={{ a: 7, b: 2 }}>{children}</CharacterGroups>);
  expect(tile.querySelector("small")).toBe(count);
  expect(count).toHaveTextContent("9장");
  expect(count).not.toHaveAttribute("aria-hidden");
});

it("omits a zero group count and counts ordinary folders separately", () => {
  const { rerender } = render(<CharacterGroups seriesId="series" members={members} groups={[]}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 3" })).toBeVisible();
  rerender(<CharacterGroups seriesId="series" members={members} groups={groups} folderCards={[<div key="folder">폴더</div>, null]}>{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 3 · 그룹 1 · 폴더 1" })).toBeVisible();
});

it("starts a group view with its member tiles and no heading or back button", () => {
  render(<CharacterGroups seriesId="series" members={members} groups={groups} activeGroupId="group">{children}</CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 2" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "시리즈로" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "그룹 편집" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("그룹 이름 그룹 캐릭터")).toBeInTheDocument();
  expect(screen.queryByText("캐릭터 3")).not.toBeInTheDocument();
});

it("renders every card in one shelf without page controls", () => {
  const many = Array.from({ length: 5 }, (_, index) => fixtureTarget(`m-${index}`, `캐릭터 ${index}`));
  const view = render(<CharacterGroups seriesId="series" members={many} groups={[]}>{page => <>{page.map(member => <button key={member.id}>{member.displayName}</button>)}</>}</CharacterGroups>);
  const shelf = view.container.querySelector<HTMLElement>(".series-characters")!;
  expect(within(shelf).getAllByRole("button")).toHaveLength(5);
  expect(screen.queryByRole("navigation", { name: "캐릭터·폴더 페이지" })).not.toBeInTheDocument();
});

it("keeps suggestions in the same shelf after registered characters", () => {
  render(<CharacterGroups seriesId="series" members={[members[0]]} groups={[]}
    suggestionCount={1} suggestionCards={[<button key="suggestion">새 캐릭터 제안</button>]}>
    {page => <>{page.map(member => <button key={member.id}>{member.displayName}</button>)}</>}
  </CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 1 · 제안 1" })).toBeVisible();
  expect(screen.getByRole("button", { name: "A" })).toBeVisible();
  expect(screen.getByRole("button", { name: "새 캐릭터 제안" })).toBeVisible();
  expect(screen.queryByRole("navigation", { name: "캐릭터·폴더 페이지" })).not.toBeInTheDocument();
});


it("masks group covers without requesting member images", () => {
 const withCovers=members.map(member=>({...member,thumbnailAssetId:`cover-${member.id}`}));
 const {container,rerender}=render(<CharacterGroups seriesId="series" members={withCovers} groups={groups}>{children}</CharacterGroups>);
 expect(container.querySelector("img[src]")).toBeTruthy();
 rerender(<CharacterGroups seriesId="series" members={withCovers} groups={groups} privacyMode>{children}</CharacterGroups>);
 expect(container.querySelector("img[src]")).toBeNull();
 expect(container.querySelectorAll(".privacy-mask")).toHaveLength(2);
});
