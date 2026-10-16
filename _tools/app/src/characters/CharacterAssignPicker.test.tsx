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

  expect(await screen.findByText("2장 중 2장")).toBeVisible();
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
  expect(screen.getByRole("button", { name: "블루 아카이브 범위 빼기" })).toBeVisible();
  expect(within(picker).getAllByRole("option", { name: /카즈사 · 현재/ })[0]).toBeVisible();
  expect(within(picker).queryByRole("option", { name: /페른/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "모든 시리즈" }));
  expect(screen.queryByRole("button", { name: "블루 아카이브 범위 빼기" })).not.toBeInTheDocument();
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
  expect(screen.queryByRole("button", { name: "블루 아카이브 범위 빼기" })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: /페른 · 40/ })).toBeVisible();
});

it("offers 기타 for the series and for each group, creating a missing one when it is chosen", async () => {
  const user = userEvent.setup();
  const onAssign = vi.fn();
  const ensureExtras = vi.fn(async (seriesId: string, groupId: string | null) => ({
    ...fixtureTarget("extras-new", "방과후 스위츠부 기타"), seriesClassificationId: seriesId, role: "extras" as const, extrasGroupId: groupId,
  }));
  const seriesExtras = { ...fixtureTarget("extras-series", "블루 아카이브 기타"), seriesClassificationId: "blue", role: "extras" as const, extrasGroupId: null };
  render(<CharacterAssignPicker assetIds={["a"]} targets={targets} groups={groups} classifications={series} counts={{ ...counts, "extras-series": 12 }}
    scopeSeriesId="blue" privacyMode={false} onAssign={onAssign} onClose={vi.fn()} extras={[seriesExtras]} ensureExtras={ensureExtras}
    loadSuggestions={vi.fn().mockResolvedValue([])} />);
  // The stored name is "<group or series> 기타"; every row says just 기타.
  const groupRows = await screen.findByRole("group", { name: "방과후 스위츠부" });
  const groupExtras = within(groupRows).getByRole("option", { name: /^기타/ });
  expect(screen.getByRole("option", { name: "기타 · 12" })).toBeVisible();
  expect(screen.queryByText(/블루 아카이브 기타/)).not.toBeInTheDocument();
  // It is the last row of its group and of the series.
  const rows = within(groupRows).getAllByRole("option");
  expect(rows[rows.length - 1]).toBe(groupExtras);
  await user.click(groupExtras);
  await waitFor(() => expect(ensureExtras).toHaveBeenCalledWith("blue", "sweets"));
  await waitFor(() => expect(onAssign).toHaveBeenCalledWith([expect.objectContaining({ id: "extras-new", role: "extras" })]));
  // A 기타 is not remembered as a recent character.
  expect(localStorage.getItem(CHARACTER_ASSIGN_RECENT_KEY)).not.toContain("extras");
});

it("offers no 기타 rows unless the owner opts in", async () => {
  render(<CharacterAssignPicker assetIds={["a"]} targets={targets} groups={groups} classifications={series} counts={counts}
    scopeSeriesId="blue" privacyMode={false} onAssign={vi.fn()} onClose={vi.fn()} loadSuggestions={vi.fn().mockResolvedValue([])} />);
  await screen.findByRole("group", { name: "방과후 스위츠부" });
  expect(screen.queryByRole("option", { name: /^기타/ })).not.toBeInTheDocument();
});

const pokemon: ClassificationEntry[] = [{ id: "pokemon", kind: "work", name: "포켓몬스터", parentId: null, iconKey: null, colorKey: null }];
const pokemonTargets = ["muku", "matiere", "rudy", "shiyu", "chili", "moran", "moyamo", "nemo"]
  .map(id => ({ ...fixtureTarget(id, id === "nemo" ? "네모" : id === "shiyu" ? "시유" : id), seriesClassificationId: "pokemon" }));
const pokemonGroups = [
  { id: "sm", seriesId: "pokemon", name: "썬/문", revision: 1, targetIds: ["muku", "matiere", "rudy"] },
  { id: "sv", seriesId: "pokemon", name: "스칼렛/바이올렛", revision: 1, targetIds: ["shiyu", "chili", "moran", "moyamo", "nemo"] },
];
const renderPokemon = (props: Partial<React.ComponentProps<typeof CharacterAssignPicker>> = {}) => render(<CharacterAssignPicker assetIds={["a"]} targets={pokemonTargets} groups={pokemonGroups}
  classifications={pokemon} counts={{ shiyu: 30, nemo: 7 }} privacyMode={false} onAssign={vi.fn()} onClose={vi.fn()} loadSuggestions={vi.fn().mockResolvedValue([])} {...props} />);

it("folds a group of more than three characters and keeps smaller groups open, unfolding on click", async () => {
  const user = userEvent.setup();
  renderPokemon();
  const small = await screen.findByRole("button", { name: /^썬\/문/ });
  const large = screen.getByRole("button", { name: /^스칼렛\/바이올렛/ });
  expect(small).toHaveAttribute("aria-expanded", "true");
  expect(large).toHaveAttribute("aria-expanded", "false");
  expect(large).toHaveTextContent("5명");
  expect(screen.getByRole("option", { name: /^matiere/ })).toBeVisible();
  expect(screen.queryByRole("option", { name: /^시유/ })).not.toBeInTheDocument();

  await user.click(large);
  expect(large).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("option", { name: /^시유/ })).toBeVisible();
  await user.click(large);
  expect(screen.queryByRole("option", { name: /^시유/ })).not.toBeInTheDocument();
});

it("skips folded rows with the arrow keys and keeps Enter on a header for folding", async () => {
  const user = userEvent.setup();
  const assign = vi.fn();
  renderPokemon({ onAssign: assign });
  const search = await screen.findByRole("searchbox", { name: "캐릭터 찾기" });
  for (let step = 0; step < 6; step += 1) fireEvent.keyDown(search, { key: "ArrowDown" });
  // The last reachable row is in the open group; the folded group's characters are never highlighted.
  expect(screen.getAllByRole("option").find(row => row.hasAttribute("data-highlighted"))).toHaveAccessibleName(/^rudy/);

  const large = screen.getByRole("button", { name: /^스칼렛\/바이올렛/ });
  large.focus();
  await user.keyboard("{Enter}");
  expect(large).toHaveAttribute("aria-expanded", "true");
  expect(assign).not.toHaveBeenCalled();
});

it("opens matching groups while searching and restores the folds when the search is cleared", async () => {
  const user = userEvent.setup();
  renderPokemon();
  const search = await screen.findByRole("searchbox", { name: "캐릭터 찾기" });
  await user.type(search, "네모");
  expect(screen.getByRole("button", { name: /^스칼렛\/바이올렛/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("option", { name: /^네모/ })).toBeVisible();

  await user.clear(search);
  expect(screen.getByRole("button", { name: /^스칼렛\/바이올렛/ })).toHaveAttribute("aria-expanded", "false");
});

it("opens the group that holds the current character", async () => {
  renderPokemon({ currentTargetId: "nemo" });
  expect(await screen.findByRole("button", { name: /^스칼렛\/바이올렛/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("option", { name: /^네모 · 현재/ })).toBeVisible();
});
