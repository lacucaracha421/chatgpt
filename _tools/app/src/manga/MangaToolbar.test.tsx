import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { MangaChoiceMenu, MangaToolbar, type MangaSource } from "./MangaToolbar";

afterEach(cleanup);
it.each(["all", "bookmarked", "local"] as MangaSource[])("keeps the %s toolbar bar inside the list and drops its trailing controls", source => {
  const label = { all: "카탈로그", bookmarked: "북마크", local: "로컬" }[source];
  render(<WorkspaceChromeProvider scope="manga"><ChromeTarget name="header" /><section className="manga-browser">
    <MangaToolbar source={source} onSourceChange={vi.fn()} localCount={30} bookmarkCount={280} chrome={{}} controls={<MangaChoiceMenu label="정렬" value="recent" onChange={vi.fn()} options={[{ value: "recent", label: "최근 변경순" }]} />} />
    <div className="manga-browser__content" data-testid="manga-scroll" style={{ overflowY: "auto" }}><p>Retained manga</p></div>
  </section></WorkspaceChromeProvider>);
  const scroller = screen.getByTestId("manga-scroll"), bar = screen.getByRole("radiogroup", { name: "망가 출처" }).closest<HTMLElement>(".ui-section-bar")!;
  expect(scroller.firstElementChild).toContainElement(bar);
  for (const name of ["카탈로그", "북마크", "로컬"]) expect(within(bar).getByRole("radio", { name })).not.toHaveTextContent(/\d/);
  expect(within(bar).getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true");
  scroller.scrollTop = 100; fireEvent.scroll(scroller);
  fireEvent.click(screen.getByRole("button", { name: `망가 · ${label}` }));
  const copy = document.querySelector(".ui-section-drop") as HTMLElement;
  expect(copy).toHaveClass("is-open");
  expect(within(copy).getByRole("button", { name: "정렬" })).toBeInTheDocument();
});
