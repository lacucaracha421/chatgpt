import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MorePanel } from "./MorePanel";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens next to the rail, bottom aligned, without a header and returns focus on dismissal", async () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
  let panelHeight = 240;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("workspace-rail")) return rect(0, 0, 64, 768);
    if (this.classList.contains("workspace-index")) return rect(64, 0, 208, 768);
    if (this.classList.contains("workspace-rail__item")) return rect(4, 700, 56, 48);
    return rect(0, 0, 280, panelHeight);
  });
  const run = vi.fn();
  render(<div className="workspace-navigation"><div className="workspace-rail"><MorePanel entries={[
    {id: "review", group: "queue", label: "유사 검토", count: 2, icon: null, run},
    {id: "settings", group: "go", label: "설정", icon: null, run},
  ]}/></div><div className="workspace-index"/><button>바깥</button></div>);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", {name: "더보기 · 유사 검토 2개"});
  await user.click(trigger);
  const panel = screen.getByRole("dialog", {name: "더보기"});
  expect(panel).toHaveStyle({left: "72px", top: "508px"});
  expect(panel.querySelector(".ui-anchored-panel__head")).toBeNull();
  expect(within(panel).queryByRole("button", {name: "더보기 닫기"})).toBeNull();
  expect(within(panel).getByRole("navigation", {name: "확인할 것"})).toBeInTheDocument();
  expect(within(panel).getByRole("navigation", {name: "이동"})).toBeInTheDocument();
  vi.stubGlobal("innerWidth", 320); vi.stubGlobal("innerHeight", 200);
  panelHeight = 160;
  fireEvent(window, new Event("resize"));
  expect(panel).toHaveStyle({left: "28px", top: "28px"});
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
  await user.click(trigger); await user.click(screen.getByRole("button", {name: "바깥"}));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
});
