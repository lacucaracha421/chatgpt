import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import type { NavigationEntry } from "./navigationEntries";
import type { DescriptionSearchResult, DescriptionSearchStatus } from "../library/types";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const row = (id: string, group: NavigationEntry["group"], run = vi.fn()): NavigationEntry => ({ id, group, label: "레베카", icon: null, run });
const source = () => ({ status: vi.fn(async () => ({ available: true, indexed: 1, qwenIndexed: 1, precise: true, worker: "ready" } satisfies DescriptionSearchStatus)), prewarm: vi.fn(async () => {}), search: vi.fn(async (): Promise<DescriptionSearchResult> => ({ route: "cosine", assetIds: ["a"], precise: true })) });

it("selects a heading-free best name and Enter opens it without requesting scene previews", async () => {
  vi.useFakeTimers(); const navigate = vi.fn(), search = source(), openScene = vi.fn();
  render(<CommandPalette open context={{tab:"assets"}} entries={[row("work", "work"), row("place-character-c", "place", navigate)]} onClose={vi.fn()} descriptionSearch={{source: search, open: openScene}} />);
  await act(async () => {});
  const input = screen.getByRole("combobox"); fireEvent.change(input, {target:{value:"레베카"}});
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  const first = screen.getAllByRole("option")[0];
  expect(first).toHaveAttribute("aria-selected", "true");
  expect(first.closest('[role="group"]')).toBeNull();
  expect(search.search).not.toHaveBeenCalled();
  expect(document.querySelector('.command-palette__strip-area')).toBeNull();
  fireEvent.keyDown(input, {key:"Enter"}); expect(navigate).toHaveBeenCalledOnce(); expect(openScene).not.toHaveBeenCalled();
});
it("Ctrl+Enter opens scene search from another scope; selecting its last row requests a preview", async () => {
  vi.useFakeTimers(); const search = source(), openScene = vi.fn();
  render(<CommandPalette open context={{tab:"assets"}} entries={[row("tag", "tag")]} onClose={vi.fn()} descriptionSearch={{source:search,open:openScene}} />);
  await act(async () => {}); const input = screen.getByRole("combobox"); fireEvent.change(input,{target:{value:"레베카"}});
  fireEvent.keyDown(input,{key:"ArrowDown"});
  await act(async () => { await vi.advanceTimersByTimeAsync(400); }); expect(search.search).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'메뉴'}));
  fireEvent.keyDown(input,{key:"Enter",ctrlKey:true}); expect(openScene).toHaveBeenCalledWith("레베카");
});
it.each(["collections", "manga", "notes"] as const)("does not offer scene search on %s", async tab => {
  const search = source(); render(<CommandPalette open context={{tab}} entries={[]} onClose={vi.fn()} descriptionSearch={{source:search,open:vi.fn()}} />);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'비 오는 거리'}}); await act(async () => {});
  expect(screen.queryByText(/장면 찾기/)).toBeNull(); expect(search.status).not.toHaveBeenCalled();
});

// Exercise the retained feature while the shipped default remains paused.
vi.mock("../../nl-search-runtime/enabled.json", () => ({ default: true }));
