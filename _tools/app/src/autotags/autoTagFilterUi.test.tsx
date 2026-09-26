import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPalette } from "../layout/CommandPalette";
import type { NavigationEntry } from "../layout/navigationEntries";
import { AutoTagFilterBadges } from "./AutoTagFilterBadges";
import { applyAutoTagFilter, clearAutoTagFilter, getAutoTagFilter, MAX_AUTO_TAG_FILTERS } from "./autoTagFilter";
import { isAssetBrowserView } from "./autoTagPalette";

afterEach(() => { cleanup(); clearAutoTagFilter(); });

it("shows filter badges with include/exclude toggle, count and clear", async () => {
  const user = userEvent.setup();
  applyAutoTagFilter("school_uniform");
  applyAutoTagFilter("glasses", "exclude");
  render(<AutoTagFilterBadges resultCount={312} />);
  expect(screen.getByText("교복")).toBeVisible();
  expect(screen.getByText("모두 포함")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("312개");
  await user.click(screen.getByRole("button", { name: "안경 포함으로 바꾸기" }));
  expect(getAutoTagFilter()).toEqual({ include: ["school_uniform", "glasses"], exclude: [] });
  await user.click(screen.getByRole("button", { name: "교복 필터 빼기" }));
  expect(getAutoTagFilter()).toEqual({ include: ["glasses"], exclude: [] });
  await user.click(screen.getByRole("button", { name: "검색 해제" }));
  expect(getAutoTagFilter()).toEqual({ include: [], exclude: [] });
  expect(screen.queryByRole("group", { name: "자동 태그 필터" })).not.toBeInTheDocument();
});

it("caps the filter at the native limit", () => {
  for (let index = 0; index < MAX_AUTO_TAG_FILTERS; index += 1) expect(applyAutoTagFilter(`tag_${index}`)).toBe(true);
  expect(applyAutoTagFilter("one_more")).toBe(false);
  // Moving an applied tag to the other side is not a new tag.
  expect(applyAutoTagFilter("tag_0", "exclude")).toBe(true);
});

it("runs a palette tag row's alternate action with Shift+Enter", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  const runAlternate = vi.fn();
  const findTags = (query: string): NavigationEntry[] => query ? [{ id: "auto-tag:glasses", group: "tag", label: "안경", context: "glasses", count: 540, icon: null, run, runAlternate }] : [];
  render(<CommandPalette open onClose={vi.fn()} entries={[]} findTags={findTags} />);
  await user.type(screen.getByRole("combobox"), "안경");
  expect(screen.getByRole("option", { name: "안경 540개" })).toBeVisible();
  expect(screen.getByText("태그 제외", { exact: false })).toBeVisible();
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(runAlternate).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
});

it("applies tag filters in place only on 에셋 browser views", () => {
  expect(isAssetBrowserView({ kind: "classification", classificationId: null })).toBe(true);
  expect(isAssetBrowserView({ kind: "album", albumId: "x" })).toBe(true);
  expect(isAssetBrowserView({ kind: "classification", classificationId: "s", characterId: "c" })).toBe(false);
  expect(isAssetBrowserView({ kind: "collections", typeFilter: "game", showcase: false })).toBe(false);
});
