import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as tauriCore from "@tauri-apps/api/core";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { CharacterGroups } from "./CharacterGroups";
import { fixtureTarget } from "./characterFixtures";
import type { CharacterTarget } from "./api";

vi.mock("@tauri-apps/api/core", { spy: true });

// A finished carry swallows the next click for 100 ms (cleared by a timer that fake timers never run): spend it here.
afterEach(() => { window.dispatchEvent(new MouseEvent("click")); cleanup(); vi.mocked(tauriCore.invoke).mockReset(); vi.restoreAllMocks(); });
beforeEach(() => { vi.mocked(tauriCore.invoke).mockResolvedValue(undefined); });

const people = (...ids: string[]) => ids.map(id => fixtureTarget(id, id.toUpperCase()));
const groups = [
  { id: "g1", name: "그룹 이름", revision: 3, targetIds: ["a", "b"] },
  { id: "g2", name: "둘째", revision: 1, targetIds: ["c"] },
];

type Overrides = Partial<React.ComponentProps<typeof CharacterGroups>>;
function setup(overrides: Overrides = {}, members: CharacterTarget[] = people("a", "b", "c", "d", "e")) {
  const reorderGroups = vi.fn().mockResolvedValue(undefined);
  const reorderCharacters = vi.fn().mockResolvedValue(undefined);
  const changed = vi.fn(), openGroup = vi.fn();
  const ui = (list: CharacterTarget[], extra: Overrides = {}) => <CharacterGroups seriesId="series" members={list} groups={groups} onReorderGroups={reorderGroups} onReorderCharacters={reorderCharacters} onGroupsChanged={changed} onOpenGroup={openGroup} {...overrides} {...extra}>
    {(visible, shelf) => <>{visible.map(target => <ContextMenu key={target.id} items={shelf.menuItems(target, false)}>
      <article className="series-character folder-shelf__card" {...shelf.cardProps(target.id)}><button className="series-character__open" aria-label={`${target.displayName} 열기`}>{target.displayName}</button></article>
    </ContextMenu>)}</>}
  </CharacterGroups>;
  const view = render(ui(members));
  return { ...view, reorderGroups, reorderCharacters, changed, openGroup, ui };
}
const labels = () => screen.getAllByRole("menuitem").map(item => item.textContent);

it("gives a group card the order menu and 그룹 편집, disabling moves that cannot happen", async () => {
  const { reorderGroups } = setup();
  fireEvent.contextMenu(screen.getByRole("button", { name: "그룹 이름 그룹 열기" }));
  expect(labels()).toEqual(["앞으로Alt+←", "뒤로Alt+→", "맨 앞으로", "맨 뒤로", "그룹 편집"]);
  expect(screen.getByRole("menuitem", { name: "앞으로" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "맨 앞으로" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "뒤로" })).toBeEnabled();
  await userEvent.click(screen.getByRole("menuitem", { name: "뒤로" }));
  expect(reorderGroups).toHaveBeenCalledWith("series", ["g2", "g1"]);
  // The last group is the mirror image.
  fireEvent.contextMenu(screen.getByRole("button", { name: "둘째 그룹 열기" }));
  expect(screen.getByRole("menuitem", { name: "뒤로" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "맨 뒤로" })).toBeDisabled();
  await userEvent.click(screen.getByRole("menuitem", { name: "그룹 편집" }));
  expect(await screen.findByRole("dialog", { name: "캐릭터 그룹 편집" })).toBeVisible();
});

it("orders loose characters from the menu and keeps the menu the same length at the ends", async () => {
  const { reorderCharacters } = setup();
  fireEvent.contextMenu(screen.getByRole("button", { name: "D 열기" }));
  expect(labels()).toEqual(["앞으로Alt+←", "뒤로Alt+→", "맨 앞으로", "맨 뒤로", "그룹에 넣기 ›"]);
  expect(screen.getByRole("menuitem", { name: "앞으로" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "맨 앞으로" })).toBeDisabled();
  await userEvent.click(screen.getByRole("menuitem", { name: "맨 뒤로" }));
  expect(reorderCharacters).toHaveBeenCalledWith("series", null, ["e", "d"]);
  fireEvent.contextMenu(screen.getByRole("button", { name: "E 열기" }));
  expect(labels()).toHaveLength(5);
  expect(screen.getByRole("menuitem", { name: "뒤로" })).toBeDisabled();
  await userEvent.click(screen.getByRole("menuitem", { name: "앞으로" }));
  expect(reorderCharacters).toHaveBeenLastCalledWith("series", null, ["e", "d"]);
});

it("puts a character into a chosen group as its last member and offers 되돌리기 once", async () => {
  const { reorderCharacters, changed } = setup();
  const user = userEvent.setup();
  fireEvent.contextMenu(screen.getByRole("button", { name: "D 열기" }));
  await user.click(screen.getByRole("menuitem", { name: /그룹에 넣기/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "그룹 이름" }));
  await waitFor(() => expect(reorderCharacters).toHaveBeenCalledWith("series", "g1", ["a", "b", "d"]));
  expect(tauriCore.invoke).toHaveBeenCalledWith("save_character_group", { request: { id: "g1", seriesId: "series", expectedRevision: 3, name: "그룹 이름", targetIds: ["a", "b", "d"], delete: false } });
  expect(changed).toHaveBeenCalled();
  expect(await screen.findByText("그룹 이름에 넣음")).toBeVisible();
  vi.mocked(tauriCore.invoke).mockClear();
  reorderCharacters.mockClear();
  await user.click(screen.getByRole("button", { name: "되돌리기" }));
  await waitFor(() => expect(reorderCharacters).toHaveBeenCalledWith("series", null, ["d", "e"]));
  expect(tauriCore.invoke).toHaveBeenCalledWith("save_character_group", { request: expect.objectContaining({ id: "g1", targetIds: ["a", "b"] }) });
  expect(reorderCharacters).toHaveBeenCalledWith("series", "g1", ["a", "b"]);
  expect(screen.queryByText("그룹 이름에 넣음")).not.toBeInTheDocument();
});

it("disables 그룹에 넣기 when the series has no group", () => {
  setup({ groups: [] });
  fireEvent.contextMenu(screen.getByRole("button", { name: "A 열기" }));
  expect(screen.getByRole("menuitem", { name: /그룹에 넣기/ })).toHaveAttribute("aria-disabled", "true");
});

it("takes a character out of the group view's menu and offers 되돌리기", async () => {
  const { reorderCharacters, changed } = setup({ activeGroupId: "g1" });
  const user = userEvent.setup();
  fireEvent.contextMenu(screen.getByRole("button", { name: "A 열기" }));
  expect(labels()).toEqual(["앞으로Alt+←", "뒤로Alt+→", "맨 앞으로", "맨 뒤로", "그룹 이름에서 빼기"]);
  await user.click(screen.getByRole("menuitem", { name: "그룹 이름에서 빼기" }));
  await waitFor(() => expect(reorderCharacters).toHaveBeenCalledWith("series", null, ["d", "e", "a"]));
  expect(tauriCore.invoke).toHaveBeenCalledWith("save_character_group", { request: expect.objectContaining({ id: "g1", targetIds: ["b"], expectedRevision: 3 }) });
  expect(changed).toHaveBeenCalled();
  expect(await screen.findByText("그룹 이름에서 뺌")).toBeVisible();
  reorderCharacters.mockClear();
  await user.click(screen.getByRole("button", { name: "되돌리기" }));
  await waitFor(() => expect(reorderCharacters).toHaveBeenCalledWith("series", null, ["d", "e"]));
  expect(reorderCharacters).toHaveBeenCalledWith("series", "g1", ["a", "b"]);
});

it("leaves the group view when taking out its last member dissolves the group", async () => {
  const { openGroup } = setup({ activeGroupId: "g2" });
  fireEvent.contextMenu(screen.getByRole("button", { name: "C 열기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "둘째에서 빼기" }));
  await waitFor(() => expect(openGroup).toHaveBeenCalledWith(null));
  expect(tauriCore.invoke).toHaveBeenCalledWith("save_character_group", { request: expect.objectContaining({ id: "g2", targetIds: [] }) });
});

it("shows a failed put-in as a message and leaves no 되돌리기", async () => {
  const { changed } = setup();
  vi.mocked(tauriCore.invoke).mockRejectedValue(new Error("그룹이 바뀌었습니다."));
  fireEvent.contextMenu(screen.getByRole("button", { name: "D 열기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /그룹에 넣기/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "둘째" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("그룹이 바뀌었습니다.");
  expect(screen.queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalled();
});

it("moves with Alt+arrows and Alt+Home/End, keeps focus on the moved card and announces its place", async () => {
  // The owner shows the new order at once, as the hub does.
  function Owner() {
    const [list, setList] = useState(people("a", "b", "c", "d", "e"));
    return <CharacterGroups seriesId="series" members={list} groups={groups}
      onReorderCharacters={async (_series, _group, ids) => { setList(old => [...old.filter(target => !ids.includes(target.id)), ...ids.map(id => old.find(target => target.id === id)!)]); }}>
      {(visible, shelf) => <>{visible.map(target => <article key={target.id} className="series-character folder-shelf__card" {...shelf.cardProps(target.id)}><button className="series-character__open">{target.displayName}</button></article>)}</>}
    </CharacterGroups>;
  }
  render(<Owner />);
  const loose = () => within(screen.getByLabelText("등록 캐릭터")).getAllByRole("button").filter(button => ["D", "E"].includes(button.textContent ?? "")).map(button => button.textContent);
  const user = userEvent.setup();
  screen.getByRole("button", { name: "D" }).focus();
  await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
  await waitFor(() => expect(loose()).toEqual(["E", "D"]));
  expect(screen.getByRole("button", { name: "D" })).toHaveFocus();
  expect(screen.getByText("D, 캐릭터 2번째")).toBeInTheDocument();
  await user.keyboard("{Alt>}{Home}{/Alt}");
  await waitFor(() => expect(loose()).toEqual(["D", "E"]));
  expect(screen.getByRole("button", { name: "D" })).toHaveFocus();
  expect(screen.getByText("D, 캐릭터 1번째")).toBeInTheDocument();
});

it("keyboard moves do nothing at the ends and ignore other modifiers", async () => {
  const { reorderCharacters, reorderGroups } = setup();
  const user = userEvent.setup();
  screen.getByRole("button", { name: "D 열기" }).focus();
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await user.keyboard("{ArrowRight}");
  await user.keyboard("{Control>}{Alt>}{ArrowRight}{/Alt}{/Control}");
  expect(reorderCharacters).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "그룹 이름 그룹 열기" }).focus();
  await user.keyboard("{Alt>}{End}{/Alt}");
  expect(reorderGroups).toHaveBeenCalledWith("series", ["g2", "g1"]);
  expect(screen.getByText("그룹 이름, 그룹 2번째")).toBeInTheDocument();
});

it("offers a retry when storing the order fails", async () => {
  const { reorderCharacters } = setup();
  reorderCharacters.mockRejectedValueOnce(new Error("저장 실패"));
  fireEvent.contextMenu(screen.getByRole("button", { name: "D 열기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "뒤로" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("순서를 바꾸지 못했습니다");
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(reorderCharacters).toHaveBeenCalledTimes(2));
  expect(reorderCharacters).toHaveBeenLastCalledWith("series", null, ["e", "d"]);
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

it("stores directly and refreshes when the owner gives no order callbacks", async () => {
  const changed = vi.fn();
  render(<CharacterGroups seriesId="series" members={people("a", "b")} groups={[]} onGroupsChanged={changed}>
    {(visible, shelf) => <>{visible.map(target => <ContextMenu key={target.id} items={shelf.menuItems(target, false)}>
      <article {...shelf.cardProps(target.id)}><button className="series-character__open">{target.displayName}</button></article></ContextMenu>)}</>}
  </CharacterGroups>);
  fireEvent.contextMenu(screen.getByRole("button", { name: "A" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "뒤로" }));
  await waitFor(() => expect(tauriCore.invoke).toHaveBeenCalledWith("reorder_character_folders", { seriesId: "series", groupId: null, targetIds: ["b", "a"] }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
});

it("holding a card in a group view adds the 그룹에서 빼기 slot, and releasing removes it", async () => {
  vi.useFakeTimers();
  try {
    setup({ activeGroupId: "g1" });
    expect(screen.queryByText("그룹에서 빼기")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "A 열기" });
    act(() => { button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })); });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText("그룹에서 빼기")).toBeInTheDocument();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(screen.queryByText("그룹에서 빼기")).not.toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});

it("shows 그룹에 넣기 over a group card while a character is carried over it", async () => {
  vi.useFakeTimers();
  try {
    setup();
    const card = screen.getByRole("button", { name: "그룹 이름 그룹 열기" }).closest<HTMLElement>("[data-order-id]")!;
    card.getBoundingClientRect = () => new DOMRect(0, 0, 132, 170);
    const track = card.parentElement!;
    track.getBoundingClientRect = () => new DOMRect(0, 0, 600, 200);
    const button = screen.getByRole("button", { name: "D 열기" });
    act(() => { button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0, clientX: 400, clientY: 50 })); });
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 66, clientY: 80 })); });
    expect(screen.getByText("그룹에 넣기")).toBeInTheDocument();
    act(() => { document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 400, clientY: 80 })); });
    expect(screen.queryByText("그룹에 넣기")).not.toBeInTheDocument();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  } finally { vi.useRealTimers(); }
});

// ---- The sub-folder band (registered series and plain folders) ----
const folderNames: Record<string, string> = { f1: "백합", f2: "레트로", f3: "기타 만화" };
function folderSetup(overrides: Overrides = {}) {
  const reorderFolders = vi.fn().mockResolvedValue(undefined);
  const result = setup({
    folderCards: ["f1", "f2", "f3"].map(id => <article key={id} className="series-character folder-shelf__card" data-order-id={id} data-order-kind="folder"><button className="series-character__open" aria-label={`${folderNames[id]} 폴더 열기`}>{folderNames[id]}</button></article>),
    folderOrder: { ids: ["f1", "f2", "f3"], names: folderNames, onReorder: reorderFolders },
    ...overrides,
  });
  return { ...result, reorderFolders };
}

it("gives a sub-folder card the order menu and stores the band through the folder callback", async () => {
  const { reorderFolders, reorderGroups, reorderCharacters } = folderSetup();
  fireEvent.contextMenu(screen.getByRole("button", { name: "백합 폴더 열기" }));
  expect(labels()).toEqual(["앞으로Alt+←", "뒤로Alt+→", "맨 앞으로", "맨 뒤로"]);
  expect(screen.getByRole("menuitem", { name: "앞으로" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "맨 앞으로" })).toBeDisabled();
  await userEvent.click(screen.getByRole("menuitem", { name: "맨 뒤로" }));
  expect(reorderFolders).toHaveBeenCalledWith(["f2", "f3", "f1"]);
  fireEvent.contextMenu(screen.getByRole("button", { name: "기타 만화 폴더 열기" }));
  expect(screen.getByRole("menuitem", { name: "뒤로" })).toBeDisabled();
  await userEvent.click(screen.getByRole("menuitem", { name: "앞으로" }));
  expect(reorderFolders).toHaveBeenLastCalledWith(["f1", "f3", "f2"]);
  expect(reorderGroups).not.toHaveBeenCalled();
  expect(reorderCharacters).not.toHaveBeenCalled();
});

it("moves a sub-folder with Alt+arrows, announces its place and keeps focus", async () => {
  const { reorderFolders } = folderSetup();
  const user = userEvent.setup();
  screen.getByRole("button", { name: "레트로 폴더 열기" }).focus();
  await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
  expect(reorderFolders).toHaveBeenLastCalledWith(["f1", "f3", "f2"]);
  expect(screen.getByText("레트로, 폴더 3번째")).toBeInTheDocument();
  await user.keyboard("{Alt>}{Home}{/Alt}");
  expect(reorderFolders).toHaveBeenLastCalledWith(["f2", "f1", "f3"]);
  expect(screen.getByRole("button", { name: "레트로 폴더 열기" })).toHaveFocus();
});

it("keeps sub-folders fixed without an order callback, and out of a group view", () => {
  const { unmount } = folderSetup({ folderOrder: undefined });
  fireEvent.contextMenu(screen.getByRole("button", { name: "백합 폴더 열기" }));
  expect(screen.queryByRole("menuitem", { name: "뒤로" })).not.toBeInTheDocument();
  unmount();
  folderSetup({ activeGroupId: "g1" });
  expect(screen.queryByRole("button", { name: "백합 폴더 열기" })).not.toBeInTheDocument();
});

it("offers a retry when storing the sub-folder order fails", async () => {
  const { reorderFolders } = folderSetup();
  reorderFolders.mockRejectedValueOnce(new Error("저장 실패"));
  fireEvent.contextMenu(screen.getByRole("button", { name: "백합 폴더 열기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "뒤로" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("순서를 바꾸지 못했습니다");
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(reorderFolders).toHaveBeenCalledTimes(2));
  expect(reorderFolders).toHaveBeenLastCalledWith(["f2", "f1", "f3"]);
});

/** Cards sit side by side, 100px apart, in a 800px shelf: groups, loose characters, then the three folders. */
function mockShelfBoxes() {
  const cards = [...document.querySelectorAll<HTMLElement>("[data-order-id]")];
  cards.forEach((card, index) => { card.getBoundingClientRect = () => new DOMRect(index * 100, 0, 100, 170); });
  cards[0]!.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, 800, 200);
  return cards;
}
function carryFolder(name: string, id: string, to: number) {
  const cards = mockShelfBoxes();
  const from = cards.findIndex(card => card.dataset.orderId === id) * 100 + 50;
  act(() => { screen.getByRole("button", { name }).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0, clientX: from, clientY: 50 })); });
  act(() => { vi.advanceTimersByTime(250); });
  act(() => { document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: to, clientY: 50 })); });
  return () => act(() => { document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", clientX: to, clientY: 50 })); });
}

it("holding a sub-folder 0.25 s lifts it and dropping it later in the band reorders the band", () => {
  vi.useFakeTimers();
  try {
    const { reorderFolders, reorderGroups, reorderCharacters } = folderSetup();
    const drop = carryFolder("백합 폴더 열기", "f1", 790);
    expect(document.querySelector<HTMLElement>('[data-order-id="f1"]')!.dataset.reorderState).toBe("source");
    drop();
    expect(reorderFolders).toHaveBeenCalledWith(["f2", "f3", "f1"]);
    expect(reorderGroups).not.toHaveBeenCalled();
    expect(reorderCharacters).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("a sub-folder dropped over a group or the characters stays inside its own band", () => {
  vi.useFakeTimers();
  try {
    const { reorderFolders, reorderGroups, reorderCharacters } = folderSetup();
    // x=50 is the middle of the first group card: a character would be put in there, a folder never is.
    const drop = carryFolder("기타 만화 폴더 열기", "f3", 50);
    expect(screen.queryByText("그룹에 넣기")).not.toBeInTheDocument();
    drop();
    expect(reorderFolders).toHaveBeenCalledWith(["f3", "f1", "f2"]);
    expect(reorderGroups).not.toHaveBeenCalled();
    expect(reorderCharacters).not.toHaveBeenCalled();
    expect(tauriCore.invoke).not.toHaveBeenCalledWith("save_character_group", expect.anything());
  } finally { vi.useRealTimers(); }
});

it("a character carried past the sub-folders only reorders the characters", () => {
  vi.useFakeTimers();
  try {
    const { reorderFolders, reorderGroups, reorderCharacters } = folderSetup();
    const cards = mockShelfBoxes();
    const from = cards.findIndex(card => card.dataset.orderId === "d") * 100 + 50;
    act(() => { screen.getByRole("button", { name: "D 열기" }).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0, clientX: from, clientY: 50 })); });
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 750, clientY: 50 })); });
    act(() => { document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", clientX: 750, clientY: 50 })); });
    expect(reorderCharacters).toHaveBeenCalledWith("series", null, ["e", "d"]);
    expect(reorderFolders).not.toHaveBeenCalled();
    expect(reorderGroups).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
