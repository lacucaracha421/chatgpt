import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ClassificationEntry } from "../library/types";
import { fixtureTarget } from "./characterFixtures";
import { CharacterAssignPicker, CHARACTER_ASSIGN_RECENT_KEY } from "./CharacterAssignPicker";

const series: ClassificationEntry[] = [
  { id: "blue", kind: "work", name: "블루 아카이브", parentId: null, iconKey: null, colorKey: null },
  { id: "frieren", kind: "work", name: "장송의 프리렌", parentId: null, iconKey: null, colorKey: null },
];
const targets = [
  { ...fixtureTarget("kazusa", "카즈사"), seriesClassificationId: "blue", thumbnailAssetId: "thumb-kazusa" },
  { ...fixtureTarget("yoshimi", "요시미"), seriesClassificationId: "blue", thumbnailAssetId: "thumb-yoshimi" },
  { ...fixtureTarget("meguri", "미노시마 메구리"), seriesClassificationId: "blue", thumbnailAssetId: "thumb-meguri", enabled: false },
  { ...fixtureTarget("fern", "페른"), seriesClassificationId: "frieren", thumbnailAssetId: "thumb-fern" },
];
const groups = [{ id: "sweets", seriesId: "blue", name: "방과후 스위츠부", revision: 1, targetIds: ["kazusa", "yoshimi"] }];
const counts = { kazusa: 20, yoshimi: 10, meguri: 30, fern: 40 };

afterEach(() => { cleanup(); localStorage.clear(); });

it("shows suggestions, recent characters and series groups in count order while masking private thumbnails", async () => {
  localStorage.setItem(CHARACTER_ASSIGN_RECENT_KEY, JSON.stringify(["fern"]));
  const { container } = render(<CharacterAssignPicker assetIds={["a", "b"]} targets={targets} groups={groups} classifications={series} counts={counts} privacyMode
    onAssign={vi.fn()} onClose={vi.fn()} loadSuggestions={vi.fn().mockResolvedValue([
      { targetId: "yoshimi", matched: 1, total: 2 },
      { targetId: "meguri", matched: 2, total: 2 },
    ])} />);

  expect(await screen.findByText("2/2장 일치")).toBeVisible();
  const recommended = screen.getByRole("group", { name: "추천" });
  expect(within(recommended).getAllByRole("option").map(row => row.textContent)).toEqual([
    expect.stringContaining("미노시마 메구리"),
    expect.stringContaining("요시미"),
  ]);
  expect(within(screen.getByRole("group", { name: "최근" })).getByText("페른")).toBeVisible();
  expect(screen.getByText("방과후 스위츠부")).toBeVisible();
  const groupRows = screen.getByRole("group", { name: "방과후 스위츠부" });
  expect(within(groupRows).getAllByRole("option").map(row => row.textContent)).toEqual([
    expect.stringContaining("카즈사"),
    expect.stringContaining("요시미"),
  ]);
  expect(container.querySelectorAll(".character-assign-picker__thumbnail--private")).not.toHaveLength(0);
  expect(container.querySelector("img")).not.toBeInTheDocument();
});

it("focuses search, supports Korean initial search and assigns the highlighted suggestion with Enter", async () => {
  const assign = vi.fn().mockResolvedValue(undefined);
  render(<CharacterAssignPicker assetIds={["a"]} targets={targets} groups={groups} classifications={series} counts={counts} privacyMode={false}
    onAssign={assign} onClose={vi.fn()} loadSuggestions={vi.fn().mockResolvedValue([{ targetId: "meguri", matched: 1, total: 1 }])} />);
  const search = screen.getByRole("searchbox", { name: "캐릭터 찾기" });
  await waitFor(() => expect(search).toHaveFocus());
  await waitFor(() => expect(screen.getAllByRole("option", { name: /미노시마 메구리/ }).find(row => row.hasAttribute("data-highlighted"))).toBeTruthy());
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => expect(assign).toHaveBeenCalledWith([expect.objectContaining({ id: "meguri" })]));

  await userEvent.type(search, "ㅍㄹ");
  expect(screen.getAllByRole("option").map(row => row.textContent)).toEqual([expect.stringContaining("페른")]);
});

it("checks several characters with Ctrl click, confirms a cross-series move, and enforces the 200 pair limit", async () => {
  const assign = vi.fn().mockResolvedValue(undefined);
  const manyAssets = Array.from({ length: 101 }, (_, index) => `asset-${index}`);
  render(<CharacterAssignPicker assetIds={manyAssets} targets={targets} groups={groups} classifications={series} counts={counts} privacyMode={false}
    onAssign={assign} onClose={vi.fn()} loadSuggestions={vi.fn().mockResolvedValue([])} />);
  fireEvent.click(await screen.findByRole("option", { name: /^카즈사 · 20$/ }), { ctrlKey: true });
  fireEvent.click(screen.getByRole("option", { name: /^페른 · 40$/ }), { ctrlKey: true });
  await userEvent.click(screen.getByRole("button", { name: "2명에게 넣기" }));
  expect(screen.getByRole("status")).toHaveTextContent("이미지 수 × 캐릭터 수는 한 번에 200개까지 지정할 수 있습니다.");
  expect(assign).not.toHaveBeenCalled();

  cleanup();
  render(<CharacterAssignPicker assetIds={["a"]} targets={targets} groups={groups} classifications={series} counts={counts} privacyMode={false}
    onAssign={assign} onClose={vi.fn()} loadSuggestions={vi.fn().mockResolvedValue([])} />);
  fireEvent.click(await screen.findByRole("option", { name: /^카즈사 · 20$/ }), { ctrlKey: true });
  fireEvent.click(screen.getByRole("option", { name: /^페른 · 40$/ }), { ctrlKey: true });
  await userEvent.click(screen.getByRole("button", { name: "2명에게 넣기" }));
  expect(screen.getByText("시리즈가 다른 캐릭터 — 첫 캐릭터의 시리즈 폴더로 옮김")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "계속 넣기" }));
  expect(assign).toHaveBeenCalledWith([
    expect.objectContaining({ id: "kazusa" }),
    expect.objectContaining({ id: "fern" }),
  ]);
});

it("limits a scoped picker to one series, marks the current character, and widens from the all-series row", async () => {
  const user = userEvent.setup();
  render(<CharacterAssignPicker assetIds={["a"]} targets={targets} groups={groups} classifications={series} counts={counts}
    scopeSeriesId="blue" currentTargetId="kazusa" privacyMode={false} onAssign={vi.fn()} onClose={vi.fn()}
    loadSuggestions={vi.fn().mockResolvedValue([{ targetId: "fern", matched: 1, total: 1 }, { targetId: "kazusa", matched: 1, total: 1 }])} />);

  const picker = await screen.findByRole("listbox", { name: "캐릭터에 넣기" });
  expect(screen.getByRole("button", { name: "블루 아카이브 범위 해제" })).toBeVisible();
  expect(within(picker).getAllByRole("option", { name: /카즈사 · 현재/ })[0]).toBeVisible();
  expect(within(picker).queryByRole("option", { name: /페른/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "모든 시리즈" }));
  expect(screen.queryByRole("button", { name: "블루 아카이브 범위 해제" })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: /페른 · 40/ })).toBeVisible();
});

it("clears a scoped picker with Backspace and offers other-series results plus creation", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn();
  render(<CharacterAssignPicker assetIds={["a"]} targets={targets} groups={groups} classifications={series} counts={counts}
    scopeSeriesId="blue" privacyMode={false} onAssign={vi.fn()} onClose={vi.fn()} onCreate={onCreate}
    loadSuggestions={vi.fn().mockResolvedValue([])} />);

  const search = await screen.findByRole("searchbox", { name: "캐릭터 찾기" });
  await user.type(search, "페른");
  expect(screen.getByText("블루 아카이브에 없음")).toBeVisible();
  expect(screen.getByText("장송의 프리렌 · 폴더 옮김")).toBeVisible();

  await user.clear(search);
  await user.type(search, "새 캐릭터");
  const create = screen.getByRole("button", { name: '블루 아카이브에 “새 캐릭터” 만들기' });
  await user.click(create);
  expect(onCreate).toHaveBeenCalledWith("새 캐릭터");

  await user.clear(search);
  fireEvent.keyDown(search, { key: "Backspace" });
  expect(screen.queryByRole("button", { name: "블루 아카이브 범위 해제" })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: /페른 · 40/ })).toBeVisible();
});
