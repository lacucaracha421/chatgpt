import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterGroups } from "./CharacterGroups";
import { fixtureTarget } from "./characterFixtures";
import type { CharacterHubApi } from "./hubApi";

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

it("shows the 기타 card after the characters and lists 기타 in the heading, even for a group that only has a 기타", () => {
  const { rerender } = render(<CharacterGroups seriesId="series" members={[members[0]]} groups={[]} extrasCard={<button>기타 열기</button>}>
    {page => <>{page.map(member => <button key={member.id}>{member.displayName}</button>)}</>}
  </CharacterGroups>);
  expect(screen.getByRole("heading", { name: "캐릭터 1 · 기타" })).toBeVisible();
  const shelf = screen.getByLabelText("등록 캐릭터");
  expect(within(shelf).getAllByRole("button").map(button => button.textContent)).toEqual(["A", "기타 열기"]);
  const only = { id: "only", name: "전쟁", revision: 1, targetIds: [], extrasTargetId: "extras" };
  rerender(<CharacterGroups seriesId="series" members={members} groups={[only]} activeGroupId="only" extrasCard={<button>기타 열기</button>}>{children}</CharacterGroups>);
  expect(screen.getByLabelText("전쟁 그룹 캐릭터")).toContainElement(screen.getByRole("button", { name: "기타 열기" }));
});

it("counts a group's 기타 images in its card", () => {
  const withExtras = [{ ...groups[0]!, extrasTargetId: "extras" }];
  render(<CharacterGroups seriesId="series" members={members} groups={withExtras} memberCounts={{ a: 7, b: 2, extras: 40 }}>{children}</CharacterGroups>);
  const tile = screen.getByRole("button", { name: "그룹 이름 그룹 열기" });
  expect(tile.querySelector("small")).toHaveTextContent("49장");
  expect(tile).toHaveAttribute("aria-description", "2명 · A · B · 기타");
});

type BrowseApi = Pick<CharacterHubApi, "browse"> & { browse: ReturnType<typeof vi.fn> };
const extrasBrowse = (ids: string[]) => ({ browse: vi.fn(async () => ({ items: ids.map(id => ({ id, thumbnailRevision: null })), nextCursor: null })) }) as unknown as BrowseApi;
const extrasSrcs = (container: HTMLElement) => [...container.querySelectorAll(".character-group-card__mosaic img")].map(image => image.getAttribute("src") ?? "");

it("fills a group that has only a 기타 with up to four of its 기타 images", async () => {
  const only = [{ id: "only", name: "전쟁", revision: 1, targetIds: [], extrasTargetId: "extras" }];
  const api = extrasBrowse(["x1", "x2", "x3", "x4", "x5"]);
  const { container } = render(<CharacterGroups seriesId="series" members={members} groups={only} extrasPreviewApi={api}>{children}</CharacterGroups>);
  await waitFor(() => expect(extrasSrcs(container)).toHaveLength(4));
  expect(container.querySelector(".character-group-card__mosaic")).toHaveAttribute("data-count", "4");
  expect(extrasSrcs(container).map(src => src.split("/").pop())).toEqual(["x1", "x2", "x3", "x4"]);
  expect(api.browse).toHaveBeenCalledTimes(1);
  expect(api.browse).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series", targetId: "extras", limit: 4 }));
});

it("fills the free slots of a group with one member after the member's cover, and masks every slot in privacy mode", async () => {
  const one = [{ id: "one", name: "한 명", revision: 1, targetIds: ["a"], extrasTargetId: "extras" }];
  const withCover = members.map(member => ({ ...member, thumbnailAssetId: `cover-${member.id}` }));
  const api = extrasBrowse(["x1", "x2", "x3", "x4"]);
  const { container, rerender } = render(<CharacterGroups seriesId="series" members={withCover} groups={one} extrasPreviewApi={api}>{children}</CharacterGroups>);
  await waitFor(() => expect(extrasSrcs(container)).toHaveLength(4));
  expect(extrasSrcs(container).map(src => src.split("/").pop())).toEqual(["cover-a", "x1", "x2", "x3"]);
  rerender(<CharacterGroups seriesId="series" members={withCover} groups={one} extrasPreviewApi={api} privacyMode>{children}</CharacterGroups>);
  expect(container.querySelector("img[src]")).toBeNull();
  expect(container.querySelectorAll(".character-group-card__mosaic .privacy-mask")).toHaveLength(4);
});

it("reads no 기타 images for a group whose members already fill the mosaic, and keeps the empty slot when nothing exists", async () => {
  const four = [fixtureTarget("a", "A"), fixtureTarget("b", "B"), fixtureTarget("c", "C"), fixtureTarget("d", "D")];
  const full = [{ id: "full", name: "가득", revision: 1, targetIds: ["a", "b", "c", "d"], extrasTargetId: "extras" }];
  const api = extrasBrowse(["x1"]);
  const { rerender, container } = render(<CharacterGroups seriesId="series" members={four} groups={full} extrasPreviewApi={api}>{children}</CharacterGroups>);
  expect(api.browse).not.toHaveBeenCalled();
  const bare = [{ id: "bare", name: "빈", revision: 1, targetIds: [], extrasTargetId: "extras" }];
  const empty = extrasBrowse([]);
  rerender(<CharacterGroups seriesId="series" members={four} groups={bare} extrasPreviewApi={empty}>{children}</CharacterGroups>);
  await waitFor(() => expect(empty.browse).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(container.querySelector(".character-group-card__slot svg")).toBeTruthy());
  expect(container.querySelector(".character-group-card__mosaic")).toHaveAttribute("data-count", "1");
});
