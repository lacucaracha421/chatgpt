import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { ViewToolbar } from "../../layout/ViewToolbar";
import { ChromeTarget, WorkspaceChromeProvider } from "../../layout/WorkspaceChrome";
import { Menu } from "./Menu";
import { SectionDropMount, useSectionDrop } from "./useSectionDrop";

const options = [{ value: "game", label: "게임" }, { value: "manga", label: "만화" }] as const;
function Fixture({ portal = false }: { portal?: boolean }) {
  const [value, setValue] = useState<"game" | "manga">("game");
  const drop = useSectionDrop({ label: "유형", options, value, onChange: setValue,
    trailing: <Menu label="정렬" trigger="정렬" items={[{ id: "sort", label: "제목순", onSelect: () => {} }]} /> });
  const content = <section className="test-host">
    <ViewToolbar title="컬렉션" sectionDrop={drop} chrome={{}} />
    <div data-testid="list" style={{ overflowY: "auto" }}>{drop.inline}<p>Retained list</p></div>
    <button type="button">Outside</button>
  </section>;
  return portal ? <WorkspaceChromeProvider scope="collection"><div className="workspace-titlebar"><ChromeTarget name="header" /><button type="button">Window action</button></div>{content}</WorkspaceChromeProvider> : content;
}
function away() {
  const list = screen.getByTestId("list");
  list.scrollTop = 100;
  fireEvent.scroll(list);
  return list;
}
const title = () => screen.getByRole("button", { name: "컬렉션 · 게임" });
const shade = () => document.querySelector<HTMLElement>(".ui-section-drop")!;
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("names the current section only after the inline bar leaves the list, including a portalled top bar", () => {
  render(<Fixture portal />);
  expect(screen.getByRole("heading", { name: "컬렉션" })).toBeInTheDocument();
  const list = away();
  expect(title()).toHaveAttribute("aria-expanded", "false");
  expect(shade()).toHaveAttribute("inert");
  expect(list.firstElementChild).toHaveClass("ui-section-bar--inline");
  expect(list).not.toContainElement(shade());
});
it("opens after 150 ms on the top bar, cancels a short hover, and closes after the 300 ms leave grace", () => {
  vi.useFakeTimers(); render(<Fixture />); away();
  const header = screen.getByRole("toolbar");
  fireEvent.pointerEnter(header); tick(149);
  expect(title()).toHaveAttribute("aria-expanded", "false");
  fireEvent.pointerLeave(header); tick(400);
  expect(title()).toHaveAttribute("aria-expanded", "false");
  fireEvent.pointerEnter(header); tick(150);
  expect(shade()).toHaveClass("is-open");
  fireEvent.pointerLeave(header); tick(299);
  expect(shade()).toHaveClass("is-open"); tick(1);
  expect(shade()).not.toHaveClass("is-open");
});
it("opens immediately from the 6 px strip and keeps open while crossing from the header to the shade", () => {
  vi.useFakeTimers(); render(<Fixture />); away();
  fireEvent.pointerEnter(document.querySelector(".ui-section-drop-hotstrip")!); tick(0);
  expect(shade()).toHaveClass("is-open");
  fireEvent.pointerLeave(document.querySelector(".ui-section-drop-hotstrip")!);
  tick(200); fireEvent.pointerEnter(shade()); tick(500);
  expect(shade()).toHaveClass("is-open");
  fireEvent.pointerLeave(shade()); tick(300);
  expect(shade()).not.toHaveClass("is-open");
});
it("title clicks toggle, a click-opened bar survives pointer leave, and outside dismisses it", () => {
  vi.useFakeTimers(); render(<Fixture />); away();
  fireEvent.click(title()); fireEvent.pointerLeave(screen.getByRole("toolbar")); tick(1000);
  expect(shade()).toHaveClass("is-open");
  fireEvent.click(title()); expect(shade()).not.toHaveClass("is-open");
  fireEvent.click(title()); fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(shade()).not.toHaveClass("is-open");
});
it("Escape closes and returns focus to the title; keyboard opening focuses the selected section", () => {
  vi.useFakeTimers(); render(<Fixture />); away();
  fireEvent.click(title(), { detail: 0 }); tick(20);
  expect(within(shade()).getByRole("radio", { name: "게임" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(shade()).not.toHaveClass("is-open"); expect(title()).toHaveFocus();
});
it("focus within the dropped bar keeps a hover-opened bar open until focus leaves", () => {
  vi.useFakeTimers(); render(<Fixture />); away();
  fireEvent.pointerEnter(screen.getByRole("toolbar")); tick(150);
  act(() => within(shade()).getByRole("radio", { name: "게임" }).focus());
  fireEvent.pointerLeave(screen.getByRole("toolbar")); tick(1000);
  expect(shade()).toHaveClass("is-open");
  act(() => screen.getByRole("button", { name: "Outside" }).focus()); tick(300);
  expect(shade()).not.toHaveClass("is-open");
});
it("picking a section closes the copy, updates the title, and retains list content", () => {
  render(<Fixture />); away(); const retained = screen.getByText("Retained list");
  fireEvent.click(title()); fireEvent.click(within(shade()).getByRole("radio", { name: "만화" }));
  expect(screen.getByRole("button", { name: "컬렉션 · 만화" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("Retained list")).toBe(retained);
});
it("returning to the top removes the copy and restores the plain title", () => {
  render(<Fixture />); const list = away(); fireEvent.click(title());
  list.scrollTop = 0; fireEvent.scroll(list);
  expect(document.querySelector(".ui-section-drop")).toBeNull();
  expect(screen.getByRole("heading", { name: "컬렉션" })).toBeInTheDocument();
});
it("a menu portalled outside the shade keeps it open, and its interactions are not outside clicks", async () => {
  const user = userEvent.setup(); render(<Fixture />); away();
  vi.useFakeTimers(); fireEvent.pointerEnter(screen.getByRole("toolbar")); tick(150); vi.useRealTimers();
  const trigger = within(shade()).getByRole("button", { name: "정렬" });
  trigger.focus(); await user.keyboard("{ArrowDown}");
  const menu = screen.getByRole("menu"); expect(shade()).not.toContainElement(menu);
  // Remove focus as well: the menu's open state alone protects the shade.
  act(() => (document.activeElement as HTMLElement).blur());
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  vi.useFakeTimers(); fireEvent.pointerLeave(screen.getByRole("toolbar")); tick(500);
  expect(shade()).toHaveClass("is-open");
  fireEvent.pointerDown(menu); expect(shade()).toHaveClass("is-open");
  vi.useRealTimers(); await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  vi.useFakeTimers();
  act(() => screen.getByRole("button", { name: "Outside" }).focus());
  tick(300); expect(shade()).not.toHaveClass("is-open");
});
it("mounts toolbar bars first inside the measured intro and retargets when the list is replaced", async () => {
  function MountFixture({ loaded }: { loaded: boolean }) { return <section className="mount-host">
    <SectionDropMount host=".mount-host" target=".intro, .fallback"><button>Sections</button></SectionDropMount>
    <div className="fallback">{loaded && <div className="intro"><p>Items</p></div>}</div>
  </section>; }
  const view = render(<MountFixture loaded={false} />);
  expect(document.querySelector(".fallback")!.firstElementChild).toContainElement(screen.getByText("Sections"));
  view.rerender(<MountFixture loaded />);
  await act(async () => {});
  expect(document.querySelector(".intro")!.firstElementChild).toContainElement(screen.getByText("Sections"));
  view.rerender(<MountFixture loaded={false} />); await act(async () => {});
  expect(document.querySelector(".fallback")!.firstElementChild).toContainElement(screen.getByText("Sections"));
});

it("reveals from the whole workspace top bar, including the window action area", () => {
  vi.useFakeTimers(); render(<Fixture portal />); away();
  fireEvent.pointerEnter(document.querySelector(".workspace-titlebar")!); tick(150);
  expect(shade()).toHaveClass("is-open");
  fireEvent.pointerLeave(document.querySelector(".workspace-titlebar")!); tick(300);
  expect(shade()).not.toHaveClass("is-open");
});

it("waits until the entire row is above the viewport and aligns the overlay with the list width", () => {
  render(<Fixture />);
  const list = screen.getByTestId("list"), inline = list.firstElementChild as HTMLElement;
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(140, 52, 600, 400));
  const measure = vi.spyOn(inline, "getBoundingClientRect").mockReturnValue(rect(140, 40, 600, 38));
  vi.spyOn(screen.getByRole("toolbar"), "getBoundingClientRect").mockReturnValue(rect(140, 0, 650, 52));
  list.scrollTop = 10; fireEvent.scroll(list);
  expect(screen.queryByRole("button", { name: "컬렉션 · 게임" })).not.toBeInTheDocument();
  measure.mockReturnValue(rect(140, 14, 600, 38)); fireEvent.scroll(list);
  expect(title()).toBeInTheDocument();
  expect(document.querySelector(".ui-section-drop-anchor")).toHaveStyle({ left: "140px", top: "52px", width: "600px" });
  measure.mockReturnValue(rect(140, 14, 550, 38)); fireEvent.resize(window);
  expect(document.querySelector(".ui-section-drop-anchor")).toHaveStyle({ width: "550px" });
});
