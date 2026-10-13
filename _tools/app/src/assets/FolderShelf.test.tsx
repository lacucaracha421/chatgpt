import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderShelf } from "./FolderShelf";
import { buildTree, sortFolders } from "../classification/buildTree";
import { withFolderSiblingOrder } from "../classification/folderOrder";
import { DEFAULT_UI_PREFERENCES, saveOptimisticUiPreferences, UI_PREFERENCES_KEY } from "../preferences/uiPreferences";
import type { ClassificationEntry } from "../library/types";

const entries = [
  { id: "parent", name: "Parent", parentId: null },
  { id: "a", name: "Alpha", parentId: "parent" },
  { id: "b", name: "Beta", parentId: "parent" },
  { id: "c", name: "Gamma", parentId: "parent" },
  { id: "other", name: "Other", parentId: null },
].map(entry => ({ ...entry, kind: "tag", iconKey: null, colorKey: null })) as ClassificationEntry[];

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function mount() {
  const persist = vi.fn();
  function Host() {
    const [preferences, setPreferences] = useState({ ...DEFAULT_UI_PREFERENCES, classificationOrderIds: ["other", "b"] });
    const children = sortFolders(entries.filter(entry => entry.parentId === "parent"), preferences.classificationOrderIds);
    return <>
      <output data-testid="sidebar">{buildTree(entries, preferences.classificationOrderIds).find(node => node.entry.id === "parent")!.children.map(node => node.entry.id).join()}</output>
      <FolderShelf entrance={false} label="폴더 3" cards={children.map(child => <article key={child.id} className="folder-shelf__card" data-order-id={child.id} data-order-kind="folder"><button className="folder-shelf__card-open">{child.name}</button></article>)}
        reorder={{ ids: children.map(child => child.id), names: Object.fromEntries(children.map(child => [child.id, child.name])), onReorder: async ids => {
          persist("parent", ids);
          saveOptimisticUiPreferences(preferences, { ...preferences, classificationOrderIds: withFolderSiblingOrder(entries, preferences.classificationOrderIds, "parent", ids) }, setPreferences);
        } }} />
    </>;
  }
  const view = render(<Host />);
  return { ...view, persist };
}
const order = () => [...document.querySelectorAll<HTMLElement>(".home-shelf__track > [data-order-id]")].map(card => card.dataset.orderId);

it("matches sidebar ranks and falls back to names for unlisted folders", () => {
  mount();
  expect(order()).toEqual(["b", "a", "c"]);
  expect(screen.getByTestId("sidebar")).toHaveTextContent("b,a,c");
});

it.each([
  ["Alpha", "ArrowLeft", ["a", "b", "c"]],
  ["Beta", "ArrowRight", ["a", "b", "c"]],
  ["Gamma", "Home", ["c", "b", "a"]],
  ["Beta", "End", ["a", "c", "b"]],
] as const)("persists Alt+%s / %s through sidebar preferences and keeps focus", async (name, key, expected) => {
  const { persist } = mount();
  const button = screen.getByRole("button", { name });
  button.focus();
  await act(async () => { fireEvent.keyDown(button, { key, altKey: true }); });
  expect(persist).toHaveBeenCalledWith("parent", expected);
  expect(order()).toEqual(expected);
  expect(screen.getByTestId("sidebar")).toHaveTextContent(expected.join());
  expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY)!).classificationOrderIds).toEqual(["other", ...expected]);
  expect(screen.getByRole("button", { name })).toHaveFocus();
});

it.each([
  ["Alpha", "앞으로", ["a", "b", "c"]],
  ["Beta", "뒤로", ["a", "b", "c"]],
  ["Gamma", "맨 앞으로", ["c", "b", "a"]],
  ["Beta", "맨 뒤로", ["a", "c", "b"]],
] as const)("persists the %s / %s menu move", async (name, label, expected) => {
  const { persist } = mount();
  fireEvent.contextMenu(screen.getByRole("button", { name }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: label })); });
  expect(persist).toHaveBeenCalledWith("parent", expected);
  expect(order()).toEqual(expected);
});

it("disables impossible moves and never offers folder reparenting", () => {
  mount();
  fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
  expect(screen.getByRole("menuitem", { name: "앞으로" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "맨 앞으로" })).toBeDisabled();
  expect(screen.getAllByRole("menuitem")).toHaveLength(4);
});

it("reverts both surfaces after a failed save and retries the requested order", async () => {
  const { persist } = mount();
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("disk full"); });
  await act(async () => { fireEvent.keyDown(screen.getByRole("button", { name: "Beta" }), { key: "End", altKey: true }); });
  expect(order()).toEqual(["b", "a", "c"]);
  expect(screen.getByTestId("sidebar")).toHaveTextContent("b,a,c");
  expect(screen.getByRole("alert")).toHaveTextContent("순서를 바꾸지 못했습니다");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "다시 시도" })); });
  expect(persist).toHaveBeenLastCalledWith("parent", ["a", "c", "b"]);
  expect(order()).toEqual(["a", "c", "b"]);
});

it("persists a held folder drag through the same sidebar path", async () => {
  vi.useFakeTimers();
  const { container, persist } = mount();
  const track = container.querySelector<HTMLElement>(".home-shelf__track")!;
  track.getBoundingClientRect = () => new DOMRect(100, 40, 600, 200);
  [...track.children].forEach((card, index) => { card.getBoundingClientRect = () => new DOMRect(100 + index * 144, 40, 132, 170); });
  fireEvent.pointerDown(screen.getByRole("button", { name: "Beta" }), { pointerType: "mouse", button: 0, clientX: 166, clientY: 100 });
  act(() => vi.advanceTimersByTime(250));
  expect(document.querySelector(".shelf-drag-ghost")).toBeTruthy();
  await act(async () => {
    fireEvent.pointerMove(document, { clientX: 500, clientY: 100 });
    fireEvent.pointerUp(document, { clientX: 500, clientY: 100 });
  });
  expect(persist).toHaveBeenCalledWith("parent", ["a", "c", "b"]);
  expect(order()).toEqual(["a", "c", "b"]);
  expect(document.querySelector(".shelf-drag-ghost")).toBeNull();
  act(() => vi.advanceTimersByTime(101));
});

it.each(["escape", "off-shelf"])("cancels a folder carry on %s without persisting", async reason => {
  vi.useFakeTimers();
  const { container, persist } = mount();
  const track = container.querySelector<HTMLElement>(".home-shelf__track")!;
  track.getBoundingClientRect = () => new DOMRect(100, 40, 600, 200);
  [...track.children].forEach((card, index) => { card.getBoundingClientRect = () => new DOMRect(100 + index * 144, 40, 132, 170); });
  fireEvent.pointerDown(screen.getByRole("button", { name: "Beta" }), { pointerType: "mouse", button: 0, clientX: 166, clientY: 100 });
  act(() => vi.advanceTimersByTime(250));
  fireEvent.pointerMove(document, { clientX: 500, clientY: 100 });
  await act(async () => {
    if (reason === "escape") fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerUp(document, { clientX: 500, clientY: reason === "off-shelf" ? 400 : 100 });
  });
  expect(persist).not.toHaveBeenCalled();
  expect(order()).toEqual(["b", "a", "c"]);
  expect(document.querySelector(".shelf-drag-ghost")).toBeNull();
  // Let the carry's click suppression expire before the next test.
  act(() => vi.advanceTimersByTime(101));
});
