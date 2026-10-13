import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement } from "react";
import * as viewportImages from "../shared/motion/viewportImages";
import * as viewSwap from "../shared/motion/viewSwap";
import * as tauriCore from "@tauri-apps/api/core";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { draftReferenceRegions, type ReferenceRegion, type CharacterTarget } from "./api";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSort, LibraryGateway } from "../library/types";
import { type CharacterGroup, type CharacterHubApi, type SeriesFolder } from "./hubApi";
import { ChromeSettingsDock, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { confirmSourceFor, shadowItem } from "./confirmTestKit";
import { s36PublicationApi } from "./S36Publication";
import { FaultGameProvider } from "../games/FaultGame";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { suggestionApi } from "./suggestions/client";
import * as suggestionComponents from "./suggestions/CharacterSuggestions";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: async () => [], ignored: async () => [] } };
});

vi.mock("@tauri-apps/api/core", { spy: true });

async function openReferencePicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "레퍼런스 추가" }));
}

/** Ctrl+click selects; a plain click only focuses (DESIGN §6, the plain-folder behaviour). */
async function selectTile(name: string) { fireEvent.click(await screen.findByRole("option", { name }), { ctrlKey: true }); }

beforeEach(() => { Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable:true,get:()=>850 },clientHeight:{configurable:true,get:()=>650} }); });
afterEach(() => { cleanup(); vi.mocked(tauriCore.invoke).mockReset(); vi.restoreAllMocks(); });

it.each([undefined, "group"])("orders characters inside their visible band from the card menu and refreshes shared data: %s", async groupId => {
  const { changed } = await mount(undefined, false, groupId ? [{ id: groupId, name: "Group", seriesId: "series", revision: 1, targetIds: ["kisaki", "hina"] }] : [], groupId);
  const invoke = vi.mocked(tauriCore.invoke).mockResolvedValue(undefined);
  const user = userEvent.setup();
  fireEvent.contextMenu(await screen.findByRole("button", { name: "히나 열기" }));
  expect(screen.getByRole("menuitem", { name: "앞으로" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "맨 앞으로" })).toBeDisabled();
  expect(screen.queryByRole("menuitem", { name: "위로 이동" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "뒤로" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reorder_character_folders", {
    seriesId: "series", groupId: groupId ?? null, targetIds: ["kisaki", "hina"],
  }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  fireEvent.contextMenu(screen.getByRole("button", { name: "키사키 열기" }));
  expect(screen.getByRole("menuitem", { name: "뒤로" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "맨 뒤로" })).toBeDisabled();
  await user.click(screen.getByRole("menuitem", { name: "앞으로" }));
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("reorder_character_folders", {
    seriesId: "series", groupId: groupId ?? null, targetIds: ["kisaki", "hina"],
  }));
  // The rest of the card menu stays: put-in or take-out, then the series move.
  fireEvent.contextMenu(screen.getByRole("button", { name: "히나 열기" }));
  expect(screen.getByRole("menuitem", { name: groupId ? "Group에서 빼기" : /그룹에 넣기/ })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "다른 시리즈로 이동…" })).toBeInTheDocument();
});

it("shows a failed order save as a message with a retry, without publishing a shared refresh", async () => {
  const { changed } = await mount();
  vi.mocked(tauriCore.invoke).mockRejectedValue(new Error("순서 저장 실패"));
  fireEvent.contextMenu(await screen.findByRole("button", { name: "키사키 열기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "앞으로" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("순서를 바꾸지 못했습니다");
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
});

it("can select and save a sixth reference without a separate additional-reference workflow", async () => {
  const { api } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  let panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "레퍼런스 추가" }));
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  await user.click(screen.getByRole("button", { name: "완료" }));
  panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ referenceIds: fixtureAssets.slice(0, 6).map(asset => asset.id) }), true));
});
it("blocks a missing original before reference inspection while allowing an available addition", async () => {
  const { api, browse } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  browse.mockResolvedValue({ items: fixtureAssets.slice(5), nextCursor: null, totalCount: 13,
    unavailableReferenceIds: [fixtureAssets[5].id] });
  const user = userEvent.setup();
  await openReferencePicker(user);
  const missing = await screen.findByRole("option", { name: "이미지 5.webp" });
  await user.click(missing);
  expect(missing).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("alert")).toHaveTextContent("이미지 5.webp");
  expect(screen.getByRole("alert")).toHaveTextContent("원본 파일이 없어");
  missing.focus();
  await user.keyboard("{Enter}");
  expect(missing).toHaveAttribute("aria-selected", "false");
  await user.click(screen.getByRole("option", { name: "이미지 6.webp" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "완료" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
    referenceIds: [...fixtureAssets.slice(0, 5).map(asset => asset.id), fixtureAssets[6].id],
  }), true));
});

it("keeps missing-original status across picker pages and refreshes it on retry", async () => {
  const { browse } = await mount("hina");
  browse.mockImplementation(async query => query.after
    ? { items: [fixtureAssets[6]], nextCursor: null, totalCount: 2 }
    : { items: [fixtureAssets[5]], nextCursor: "next", totalCount: 2,
      unavailableReferenceIds: [fixtureAssets[5].id] });
  const user = userEvent.setup();
  await openReferencePicker(user);
  await screen.findByRole("option", { name: "이미지 6.webp" });
  const missing = screen.getByRole("option", { name: "이미지 5.webp" });
  await user.click(missing);
  expect(missing).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("alert")).toHaveTextContent("원본 파일이 없어");

  browse.mockResolvedValue({ items: fixtureAssets.slice(5, 7), nextCursor: null, totalCount: 2 });
  const calls = browse.mock.calls.length;
  await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(browse.mock.calls.length).toBeGreaterThan(calls));
  await waitFor(() => expect(screen.queryByText("원본이 없는 이미지는 선택할 수 없습니다. 썸네일은 남아 있을 수 있습니다.")).not.toBeInTheDocument());
  await user.click(screen.getByRole("option", { name: "이미지 5.webp" }));
  expect(screen.getByRole("option", { name: "이미지 5.webp" })).toHaveAttribute("aria-selected", "true");
});

async function mount(targetId?: string, pendingOnly = false, groups: CharacterGroup[] = [], groupId?: string, withChrome = false, legacy?: { sort?: AssetSort; onSortChange?: (sort: AssetSort) => void; targetOverrides?: Partial<CharacterTarget>; seriesAutoClassify?: boolean; excludedCount?: number; targetEnabled?: boolean; folders?: SeriesFolder[];  privacyMode?: boolean; sourceUrl?: string; candidates?: number; shadowItems?: string[]; fault?: boolean; gateway?: Partial<LibraryGateway>; inspect?: (seriesId: string, targetId: string | null, assetIds: string[], regions?: Record<string, unknown>) => Promise<unknown[]> }) {
  const api=createCharacterFixture(), sourceTargets=await api.targets();
  const targets = sourceTargets.map(target => target.id === (targetId ?? "hina") ? {
    ...target,
    ...(legacy?.targetEnabled === undefined ? {} : { enabled: legacy.targetEnabled, ready: legacy.targetEnabled && target.ready }),
    ...legacy?.targetOverrides,
  } : target);
  if (legacy?.inspect) api.inspectReferenceRegions = vi.fn(legacy.inspect) as unknown as typeof api.inspectReferenceRegions;
  if (pendingOnly) { api.reviewPending = vi.fn(async () => true); vi.spyOn(api, "review"); }
  const browse=vi.fn().mockResolvedValue({ items:fixtureAssets.slice(5).map(asset => ({ ...asset, sourceUrl: legacy?.sourceUrl ?? asset.sourceUrl })),nextCursor:null,totalCount:13 });
  const hubApi={seriesFolders:vi.fn().mockResolvedValue(legacy?.folders ?? []),browse,saveSeries:vi.fn(),series:vi.fn(),createManualCharacter:vi.fn(),completeReview:vi.fn().mockResolvedValue(1),setSeriesAssetExcluded:vi.fn(),excludedAssets:vi.fn().mockResolvedValue({items:[],nextCursor:null,totalCount:legacy?.excludedCount ?? 0}),
    referenceCandidates:vi.fn(async(targetId:string)=>{ const target=targets.find(item=>item.id===targetId)!; return {targetId,targetRevision:target.revision,referenceSetHash:`set-${targetId}`,confirmationMode:target.manualOnly?"initialize":"add_learned",minimumSelection:target.manualOnly?5:1,items:fixtureAssets.slice(5,7),suggestedAssetIds:fixtureAssets.slice(5,7).map(item=>item.id)}; }),
    confirmReferenceBatch:vi.fn(async()=>targets[0]),
    requestReferenceRefresh:vi.fn(async(targetId:string)=>({targetId,requestRevision:1,state:"pending" as const,eligibleCount:12})),
  } as CharacterHubApi;
  const confirmSource=confirmSourceFor({counts:{recognition:legacy?.candidates ?? 0},candidates:(legacy?.shadowItems ?? []).map(assetId=>shadowItem(assetId,"hina","히나"))});
  const navigate=vi.fn(),changed=vi.fn();
  const onGalleryLayoutChange=vi.fn(),onMetadataVisibleChange=vi.fn(),onPrivacyModeChange=vi.fn(),onThumbnailRowHeightChange=vi.fn();
  const gateway={listAssets:vi.fn().mockResolvedValue({items:fixtureAssets,nextCursor:null}),openLibrary:vi.fn(),...legacy?.gateway} as unknown as LibraryGateway;
  const browser=<SeriesBrowser targetId={targetId} groupId={groupId} series={{classificationId:"series",heroAssetId:null,autoClassify:legacy?.seriesAutoClassify ?? true}} targets={targets} groups={groups} classifications={[...fixtureClassifications, {id:"machines",name:"기체",kind:"tag",parentId:"series",iconKey:null,colorKey:null}]} galleryLayout="masonry" onGalleryLayoutChange={onGalleryLayoutChange} sort={legacy?.sort} onSortChange={legacy?.onSortChange} privacyMode={legacy?.privacyMode ?? false} onPrivacyModeChange={onPrivacyModeChange} metadataVisible onMetadataVisibleChange={onMetadataVisibleChange} thumbnailRowHeight={180} onThumbnailRowHeightChange={onThumbnailRowHeightChange} refreshVersion={0} onNavigate={navigate} onChanged={changed} api={api} hubApi={hubApi} confirmSource={confirmSource} />;
  const content = withChrome ? <WorkspaceChromeProvider scope="series"><div className="workspace-navigation"><aside className="workspace-index"><ChromeSettingsDock /></aside>{browser}</div></WorkspaceChromeProvider> : browser;
  const rendered = render(<LibraryProvider gateway={gateway}>{legacy?.fault ? <PrivacyProvider privacyMode={false} setPrivacyMode={() => undefined}><FaultGameProvider>{content}</FaultGameProvider></PrivacyProvider> : content}</LibraryProvider>);
  const navigateToCharacter = (id?: string) => rendered.rerender(<LibraryProvider gateway={gateway}>{cloneElement(browser, { targetId: id })}</LibraryProvider>);
  const navigateToGroup = (id: string) => rendered.rerender(<LibraryProvider gateway={gateway}>{cloneElement(browser, { groupId: id })}</LibraryProvider>);
  const showTargets = (next: CharacterTarget[]) => rendered.rerender(<LibraryProvider gateway={gateway}>{cloneElement(browser, { targets: next })}</LibraryProvider>);
  return {api,targets,showTargets,browse,confirmSource,navigate,changed,hubApi,onGalleryLayoutChange,onMetadataVisibleChange,onPrivacyModeChange,onThumbnailRowHeightChange,navigateToCharacter,navigateToGroup};
}

it.each(["group", "character"])("keeps the active kind chip when opening a %s and resets the empty gallery", async destination => {
  const mounted = await mount(undefined, false, destination === "group" ? [{ id: "duo", seriesId: "series", name: "선도부", revision: 1, targetIds: ["hina", "kisaki"] }] : []);
  await screen.findByRole("option", { name: "이미지 5.webp" });
  mounted.browse.mockImplementation(async query => ({ items: query.view?.mediaKind === "videos" ? [] : fixtureAssets.slice(5), nextCursor: null, totalCount: query.view?.mediaKind === "videos" ? 0 : 13 }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "보기" }));
  await user.click(within(screen.getByRole("radiogroup", { name: "종류" })).getByRole("radio", { name: "영상" }));
  await user.keyboard("{Escape}");
  await screen.findByRole("heading", { name: "영상 없음" });
  mounted.navigate.mockImplementation(view => {
    if (view.characterGroupId) mounted.navigateToGroup(view.characterGroupId);
    if (view.characterId) mounted.navigateToCharacter(view.characterId);
  });
  await user.click(screen.getByRole("button", { name: destination === "group" ? "선도부 그룹 열기" : "히나 열기" }));
  await waitFor(() => expect(mounted.browse).toHaveBeenLastCalledWith(expect.objectContaining({
    ...(destination === "group" ? { groupId: "duo" } : { targetId: "hina" }),
    view: expect.objectContaining({ mediaKind: "videos" }),
  })));
  expect(screen.getByRole("group", { name: "보기 필터" })).toHaveTextContent("영상만");
  const empty = (await screen.findByRole("heading", { name: "영상 없음" })).closest("section")!;
  expect(within(empty).getByText("영상만 보는 중")).toBeVisible();
  await user.click(within(empty).getByRole("button", { name: "필터 초기화" }));
  expect(await screen.findByRole("option", { name: "이미지 5.webp" })).toBeVisible();
  expect(mounted.browse.mock.lastCall![0]).not.toHaveProperty("view");
  expect(screen.queryByRole("group", { name: "보기 필터" })).not.toBeInTheDocument();
});

it("hides the retained view filter chip while picking references", async () => {
  await mount("hina");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "보기" }));
  await user.click(within(screen.getByRole("radiogroup", { name: "종류" })).getByRole("radio", { name: "영상" }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("group", { name: "보기 필터" })).toHaveTextContent("영상만");
  await openReferencePicker(user);
  await screen.findByRole("button", { name: "완료" });
  expect(screen.queryByRole("group", { name: "보기 필터" })).not.toBeInTheDocument();
});

it("shows an inner series after characters and before ordinary folders without an exclusion menu", async () => {
  const {navigate}=await mount(undefined, false, [], undefined, false, { folders: [
    {classificationId:"series",isSeries:true,thumbnailAssetId:null},
    {classificationId:"machines",thumbnailAssetId:"asset-5"},
  ] });
  const inner=await screen.findByRole("button",{name:/시리즈 열기$/});
  expect(inner).toHaveAttribute("aria-description","캐릭터 시리즈");
  const buttons=[...inner.closest('.home-shelf__track')!.querySelectorAll('.series-character__open')];
  expect(buttons.indexOf(inner)).toBeGreaterThan(buttons.indexOf(screen.getByRole("button",{name:"히나 열기"})));
  expect(buttons.indexOf(inner)).toBeLessThan(buttons.indexOf(screen.getByRole("button",{name:"기체 폴더 열기"})));
  expect(inner.closest('article')!.querySelector('.series-character__info')).toBeNull();
  fireEvent.click(inner);
  expect(navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series"});
});

it("keeps the character screen until the returning folder page and shelf thumbnails are ready", async () => {
  const mounted = await mount();
  await screen.findByRole("option", { name: "이미지 5.webp" });
  const shelfImage = screen.getByRole("button", { name: "히나 열기" }).querySelector("img");
  mounted.browse.mockResolvedValue({ items: [fixtureAssets[0]], nextCursor: null, totalCount: 24 });
  mounted.navigateToCharacter("hina");
  await waitFor(() => expect(document.querySelector('.character-group-heading__count')).toHaveTextContent('24'));
  let resolveFolder!: (page: { items: typeof fixtureAssets; nextCursor: null; totalCount: number }) => void;
  mounted.browse.mockImplementationOnce(() => new Promise(resolve => { resolveFolder = resolve; }));
  let decoded!: () => void;
  const preload = vi.spyOn(viewportImages, "preloadImages").mockImplementationOnce(() => new Promise<void>(resolve => { decoded = resolve; }));
  mounted.navigateToCharacter();
  expect(screen.queryByRole("radiogroup", { name: "시리즈 이미지 필터" })).toBeNull();
  expect(document.querySelector('.character-group-heading__count')).toHaveTextContent('24');
  await act(async () => resolveFolder({ items: [fixtureAssets[5]], nextCursor: null, totalCount: 21 }));
  await waitFor(() => expect(preload).toHaveBeenCalled());
  expect(screen.queryByRole("radiogroup", { name: "시리즈 이미지 필터" })).toBeNull();
  expect(document.querySelector('[data-asset-id]')).toHaveAttribute('data-asset-id', fixtureAssets[0].id);
  await act(async () => decoded());
  expect(await screen.findByRole("radio", { name: "미분류 21" })).toBeInTheDocument();
  expect(document.querySelector('[data-asset-id]')).toHaveAttribute('data-asset-id', fixtureAssets[5].id);
  expect(screen.getByRole("button", { name: "히나 열기" }).querySelector("img")).toBe(shelfImage);
});

it("swaps 미분류 and 전체 in one quiet step once the new page is ready", async () => {
  const mounted = await mount();
  await screen.findByRole("option", { name: "이미지 5.webp" });
  const scroller = document.querySelector<HTMLElement>('.asset-gallery__scroll')!;
  scroller.scrollTop = 80; fireEvent.scroll(scroller);
  const swap = vi.spyOn(viewSwap, "swapSegment");
  let ready: (() => void) | undefined;
  vi.spyOn(viewportImages, "preloadImages").mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
  mounted.browse.mockResolvedValue({ items: Array.from({ length: 113 }, (_, index) => ({ ...fixtureAssets[index % fixtureAssets.length], id: `all-${index}` })), nextCursor: null, totalCount: 113 });
  await userEvent.click(screen.getByRole("radio", { name: "전체" }));
  await waitFor(() => expect(ready).toBeDefined());
  // The old page and its count stay until the new first screen is ready.
  expect(scroller.scrollTop).toBe(80);
  expect(screen.getByRole("radio", { name: "미분류 13" })).toHaveAttribute('aria-checked', 'true');
  await act(async () => { ready!(); ready = undefined; });
  expect(screen.getByRole("radio", { name: "전체 113" })).toHaveAttribute('aria-checked', 'true');
  expect(scroller.scrollTop).toBe(80);
  expect(document.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
  mounted.browse.mockResolvedValue({ items: [fixtureAssets[5]], nextCursor: null, totalCount: 1 });
  await userEvent.click(screen.getByRole("radio", { name: "미분류" }));
  expect(screen.getByRole("radio", { name: "전체 113" })).toHaveAttribute('aria-checked', 'true');
  await waitFor(() => expect(ready).toBeDefined());
  await act(async () => { ready!(); ready = undefined; });
  expect(screen.getByRole("radio", { name: "미분류 1" })).toHaveAttribute('aria-checked', 'true');
  expect(scroller.scrollTop).toBe(0);
  expect(swap).not.toHaveBeenCalled();
});

it("offers 다른 시리즈로 이동… for a character, lists nested series, and opens the character in its new series once the hub lists it", async () => {
  const { targets, showTargets, navigate, changed, browse } = await mount("hina");
  const hina = targets.find(target => target.id === "hina")!;
  const invoke = vi.mocked(tauriCore.invoke).mockImplementation((async (command: string) => {
    if (command === "character_series") return ["series", "machines"].map(classificationId => ({ classificationId, autoClassify: true, heroAssetId: null }));
    if (command === "character_series_move_preview") return { targetId: "hina", destinationId: "machines", assetCount: 4, relocationCount: 4, sharedCount: 0, groupName: null, token: "t" };
    if (command === "move_character_to_series") return { ...hina, seriesClassificationId: "machines" };
    return undefined;
  }) as typeof tauriCore.invoke);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  await user.click(screen.getByRole("menuitem", { name: "다른 시리즈로 이동…" }));
  const dialog = await screen.findByRole("dialog", { name: "히나 · 다른 시리즈로 이동" });
  const select = within(dialog).getByRole("combobox", { name: "대상 시리즈" });
  await waitFor(() => expect(select).toBeEnabled());
  // The open series is excluded; the nested registered series is offered.
  expect(within(select).getAllByRole("option").map(option => option.textContent)).toEqual(["시리즈 선택", "블루 아카이브 / 기체"]);
  await user.selectOptions(select, "machines");
  await user.click(await within(dialog).findByRole("button", { name: "이동" }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith("move_character_to_series", { targetId: "hina", destinationId: "machines", token: "t" });
  expect(screen.queryByRole("dialog", { name: "히나 · 다른 시리즈로 이동" })).toBeNull();
  // Until the hub lists the character in the new series, this view stays as it is: no reload, no navigation.
  const loads = browse.mock.calls.length;
  expect(navigate).not.toHaveBeenCalled();
  showTargets(targets.map(target => target.id === "hina" ? { ...target, seriesClassificationId: "machines" } : target));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: "classification", classificationId: "machines", characterId: "hina" }));
  expect(browse.mock.calls.length).toBe(loads);
});

it("has no 캐릭터 더보기 menu (so no series move) on a 기타 bucket", async () => {
  await mount("hina", false, [], undefined, false, { targetOverrides: { role: "extras" } });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(screen.queryByRole("button", { name: "캐릭터 더보기" })).toBeNull();
});

it("provides working display settings inside character folders", async () => {
  const callbacks=await mount("hina",false,[],undefined,true); const user=userEvent.setup();
  const trigger=await screen.findByRole("button",{name:"보기"});
  expect(trigger).toBeEnabled();
  await user.click(trigger);
  await user.click(within(screen.getByRole("menu")).getByRole("radio",{name:"같은 높이"}));
  expect(callbacks.onGalleryLayoutChange).toHaveBeenCalledWith("justified");
  expect(callbacks.onMetadataVisibleChange).not.toHaveBeenCalled();
  expect(callbacks.onPrivacyModeChange).not.toHaveBeenCalled();
});
const viewSections = () => [...screen.getByRole("menu").querySelectorAll(".ui-section-label__title")].map(node => node.textContent);
it("offers a plain folder's 보기 options in a series folder and sends them with the series query", async () => {
  const onSortChange = vi.fn();
  const { browse } = await mount(undefined, false, [], undefined, false, { sort: "newest", onSortChange });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "보기" }));
  // 미분류/전체 stays above the series gallery, so the menu starts with 종류.
  expect(viewSections()).toEqual(["종류", "배치", "정렬", "비율", "표시"]);
  expect(within(screen.getByRole("radiogroup", { name: "정렬" })).getAllByRole("radio").map(radio => radio.textContent)).toEqual(["최신순", "오래된순", "좋아요순", "랜덤"]);
  expect(screen.getAllByRole("switch").map(item => item.getAttribute("aria-label"))).toEqual(["비공개 모드", "NSFW 필터", "정보"]);
  await user.click(within(screen.getByRole("radiogroup", { name: "종류" })).getByRole("radio", { name: "영상" }));
  await waitFor(() => expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: null, seriesFilter: "unclassified",
    view: { sort: "newest", randomPivot: null, mediaKind: "videos", aspectRatio: null } })));
  await user.click(within(screen.getByRole("radiogroup", { name: "정렬" })).getByRole("radio", { name: "좋아요순" }));
  expect(onSortChange).toHaveBeenCalledWith("favorites");
});
it("offers sort, kind and ratio in a character folder and reshuffles a random character gallery", async () => {
  const { browse } = await mount("hina", false, [], undefined, false, { sort: "random", onSortChange: vi.fn() });
  await waitFor(() => expect(browse).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina",
    view: expect.objectContaining({ sort: "random", randomPivot: expect.any(String), mediaKind: null, aspectRatio: null }) })));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "보기" }));
  expect(viewSections()).toEqual(["종류", "배치", "정렬", "비율", "표시"]);
  const pivot = browse.mock.lastCall![0].view.randomPivot;
  await user.click(screen.getByRole("button", { name: "다시 섞기" }));
  await waitFor(() => expect(browse.mock.lastCall![0].view.randomPivot).not.toBe(pivot));
  await user.click(within(screen.getByRole("radiogroup", { name: "비율" })).getByRole("radio", { name: "세로형" }));
  await waitFor(() => expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: "hina", view: expect.objectContaining({ sort: "random", aspectRatio: "portrait" }) })));
});
it("keeps the default series query free of a view", async () => {
  const { browse } = await mount(undefined, false, [], undefined, false, { sort: "newest", onSortChange: vi.fn() });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(browse.mock.calls.every(([query]) => !("view" in query))).toBe(true);
});
it("opens a character relation from its card without changing classifications",async()=>{
  const {navigate,browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"히나 열기"}));
  expect(navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterId:"hina"});
  expect(browse).toHaveBeenCalledWith(expect.objectContaining({targetId:null,all:false}));
});
it("keeps normal series browsing free of review and exclusion work", async () => {
  await mount();
  const filters = await screen.findByRole("radiogroup", { name: "시리즈 이미지 필터" });
  expect(within(filters).getByRole("radio", { name: "미분류 13" })).toBeInTheDocument();
  expect(within(filters).getByRole("radio", { name: "전체" })).toBeInTheDocument();
  expect(within(filters).queryByRole("radio", { name: "제외한 이미지" })).not.toBeInTheDocument();
  await selectTile("이미지 5.webp");
  const selectionBar = screen.getByRole("toolbar", { name: "선택 작업" });
  expect(within(selectionBar).getByText("1개 선택")).toBeVisible();
  expect(within(selectionBar).getByRole("button", { name: "캐릭터 지정" })).toBeVisible();
  expect(within(selectionBar).queryByRole("button", { name: "자동 분류에서 제외" })).not.toBeInTheDocument();
  await userEvent.setup().click(within(selectionBar).getByRole("button", { name: "캐릭터 지정" }));
  expect(await screen.findByRole("listbox", { name: "캐릭터에 넣기" })).toBeVisible();
});

it("renders characters, suggestions, and folders in one shelf with the label actions nearby", async () => {
  vi.spyOn(suggestionApi, "list").mockResolvedValue([{
    tag: "new_character", imageCount: 16, bothCount: 16, pixaiCount: 16, canaryCount: 16,
    sampleAssetIds: [], seriesId: "series", seriesName: "블루 아카이브", insideCount: 16,
  }]);
  await mount(undefined, false, [], undefined, false, { folders: [{ classificationId: "machines", thumbnailAssetId: "asset-5" }] });
  const shelf = await screen.findByRole("region", { name: "캐릭터와 일반 폴더" });
  expect(within(shelf).getByRole("button", { name: "히나 열기" })).toBeInTheDocument();
  expect(within(shelf).getByRole("button", { name: "기체 폴더 열기" })).toBeInTheDocument();
  expect(within(shelf).getByRole("button", { name: /제안 16장/ })).toBeInTheDocument();
  expect(within(shelf).getByText("제안")).toBeInTheDocument();
  expect(within(shelf).queryByRole("navigation", { name: "캐릭터·폴더 페이지" })).not.toBeInTheDocument();
  expect(screen.getByRole("radiogroup", { name: "시리즈 이미지 필터" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "제안 숨기기" })).toBeInTheDocument();
});

it("keeps suggestion nodes, images and render counts stable when folder icons are hovered", async () => {
  const list = vi.spyOn(suggestionApi, "list").mockResolvedValue([{
    tag: "new_character", imageCount: 16, bothCount: 16, pixaiCount: 16, canaryCount: 16,
    sampleAssetIds: ["sample-1", "sample-2"], seriesId: "series", seriesName: "블루 아카이브", insideCount: 16,
  }]);
  const tileRender = vi.spyOn(suggestionComponents, "CharacterSuggestionTile");
  const { browse } = await mount(undefined, false, [
    { id: "group", name: "그룹", seriesId: "series", revision: 1, targetIds: ["kisaki"] },
  ], undefined, false, { folders: [{ classificationId: "machines", thumbnailAssetId: "asset-5" }] });
  const suggestion = await screen.findByRole("button", { name: /제안 16장/ });
  const images = [...suggestion.querySelectorAll("img")];
  const sources = images.map(image => image.src);
  const renderCount = tileRender.mock.calls.length;
  expect(renderCount).toBeGreaterThan(0);
  const listCount = list.mock.calls.length;
  const browseCount = browse.mock.calls.length;
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver(records => mutations.push(...records));
  observer.observe(suggestion.closest(".folder-shelf")!, { subtree: true, childList: true, attributes: true });
  try {
    const user = userEvent.setup();
    for (const name of ["히나 열기", "그룹 그룹 열기", "기체 폴더 열기"]) {
      const folder = screen.getByRole("button", { name });
      for (const icon of [folder.querySelector("strong svg")!, folder.querySelector("img")!]) {
        fireEvent.pointerEnter(icon, { pointerType: "mouse" });
        fireEvent.mouseOver(icon);
        await user.hover(icon);
        expect(screen.getByRole("button", { name: /제안 16장/ })).toBe(suggestion);
        expect(suggestion).toBeVisible();
        const currentImages = [...suggestion.querySelectorAll("img")];
        expect(currentImages).toHaveLength(images.length);
        images.forEach((image, index) => {
          expect(currentImages[index]).toBe(image);
          expect(image).toBeVisible();
          expect(image.src).toBe(sources[index]);
        });
        await user.unhover(icon);
      }
    }
    mutations.push(...observer.takeRecords());
    expect(mutations).toEqual([]);
    expect(tileRender).toHaveBeenCalledTimes(renderCount);
    expect(list).toHaveBeenCalledTimes(listCount);
    expect(browse).toHaveBeenCalledTimes(browseCount);
  } finally { observer.disconnect(); }
});

it("shows legacy series recovery only when legacy state exists", async () => {
  await mount(undefined, false, [], undefined, false, { seriesAutoClassify: false, excludedCount: 2 });
  expect(await screen.findByRole("button", { name: "자동 인식 켜기" })).toBeInTheDocument();
  const filters = screen.getByRole("radiogroup", { name: "시리즈 이미지 필터" });
  expect(within(filters).getByRole("radio", { name: "제외한 이미지" })).toBeInTheDocument();
});

it("does not poll or expose character review in normal character browsing", async () => {
  const { api } = await mount("hina", true);
  await screen.findByRole("toolbar", { name: "시리즈 도구" });
  expect(screen.queryByRole("button", { name: /검토/ })).not.toBeInTheDocument();
  expect(api.reviewPending).not.toHaveBeenCalled();
  expect(api.review).not.toHaveBeenCalled();
});

it("hides normal series automation controls", async () => {
  await mount("hina");
  expect(screen.queryByRole("button", { name: /자동 분류 설정/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "자동 인식 켜기" })).not.toBeInTheDocument();
});

it("shows a mosaic group card and opens the group asset union",async()=>{
  const groups: CharacterGroup[]=[{id:"duo",seriesId:"series",name:"선도부",revision:1,targetIds:["hina","kisaki"]}];
  const {navigate}=await mount(undefined,false,groups); const user=userEvent.setup();
  const card=await screen.findByRole("button",{name:"선도부 그룹 열기"});
  expect(card.querySelector(".character-group-card__mosaic")).toHaveAttribute("data-count","2");
  const groupIcon = card.querySelector(".character-group-card__icon");
  expect(groupIcon).not.toHaveClass("series-character__ready");
  expect(screen.queryByRole("button",{name:"히나 열기"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"키사키 열기"})).not.toBeInTheDocument();
  await user.click(card);
  expect(navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterGroupId:"duo"});

  cleanup();
  const mounted=await mount(undefined,false,groups,"duo");
  expect(await screen.findByRole("button",{name:"히나 열기"})).toBeVisible();
  expect(screen.getByRole("button",{name:"키사키 열기"})).toBeVisible();
  await waitFor(()=>expect(mounted.browse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",targetId:null,groupId:"duo"})));
  // No group heading, back button or "이미지" section line: the titlebar carries name, count and actions.
  expect(screen.queryByRole("heading",{name:/그룹 · 선도부|선도부 이미지/})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"시리즈로"})).not.toBeInTheDocument();
  const more=within(screen.getByRole("toolbar",{name:"시리즈 도구"})).getByRole("button",{name:"그룹 더보기"});
  expect(more.querySelector("path")?.getAttribute("d")).not.toBe("M3 10h4v4H3zM10 10h4v4h-4zM17 10h4v4h-4z");
  await user.click(more);
  await user.click(await screen.findByRole("menuitem",{name:"그룹 편집"}));
  expect(await screen.findByRole("dialog",{name:"캐릭터 그룹 편집"})).toBeVisible();
});

it("opens a member character editor from inside a group view", async () => {
  const groups: CharacterGroup[] = [{ id: "duo", seriesId: "series", name: "선도부", revision: 1, targetIds: ["hina", "kisaki"] }];
  await mount(undefined, false, groups, "duo");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  expect(await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" })).toBeVisible();
});

it("disables native dragging on character card thumbnails", async () => {
  await mount();
  const card = await screen.findByRole("button", { name: "히나 열기" });
  expect(card.querySelector("img")).toHaveAttribute("draggable", "false");
});

it("selects in the existing gallery and preserves the editor draft",async()=>{
  const {api,browse,navigate}=await mount(); const saveSettings=vi.spyOn(api,"saveSettings"); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"히나 편집"}));
  let panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.click(within(panel).getByText("관리"));
  await user.type(within(panel).getByLabelText("설명"),"기준 설명");
  await user.click(within(panel).getByRole("button",{name:"레퍼런스 추가"}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",referenceTargetId:"hina",targetId:"hina",all:true})));
  await user.click(screen.getByRole("button",{name:"선택 이미지 1 해제"}));
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await user.click(screen.getByRole("button",{name:"완료"}));
  panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  expect(within(panel).getByLabelText("설명")).toHaveValue("기준 설명");
  await user.click(within(panel).getByRole("button",{name:"저장"}));
  await waitFor(()=>expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({description:"기준 설명",referenceIds:expect.any(Array)}),true));
  expect(navigate).not.toHaveBeenCalled();
});
it("filters a new character's selection even when all is requested",async()=>{
  const {browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 만들기"}));
  let panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  await user.type(within(panel).getByLabelText("캐릭터 이름"),"아루");
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({referenceTargetId:"",all:false})));
  await user.click(screen.getByRole("button",{name:"전체 보기"}));
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({referenceTargetId:"",all:true})));
  await user.click(screen.getByRole("button",{name:"취소"}));
  panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  expect(within(panel).getByLabelText("캐릭터 이름")).toHaveValue("아루");
});


it("reuses one candidate snapshot for thumbnail and reference picking",async()=>{
  const {browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 만들기"}));
  let panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  await user.type(within(panel).getByLabelText("캐릭터 이름"),"아루");
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({referenceTargetId:"",targetId:null,all:false})));
  const candidateCalls=()=>browse.mock.calls.filter(([query])=>query.referenceTargetId==="" && query.all===false).length;
  expect(candidateCalls()).toBe(1);
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await user.click(screen.getByRole("button",{name:"완료"}));
  panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  await user.click(within(panel).getByRole("button",{name:"레퍼런스 추가"}));
  await screen.findByRole("option",{name:"이미지 5.webp"});
  expect(candidateCalls()).toBe(1);
});

it("keeps the series header to a quiet create icon and one overflow for cover and group setup",async()=>{
  await mount(undefined,false,[],undefined,true);
  const user=userEvent.setup();
  const toolbar=screen.getByRole("toolbar",{name:"시리즈 도구"});
  const create=within(toolbar).getByRole("button",{name:"캐릭터 만들기"});
  expect(create).toHaveTextContent("");
  expect(screen.queryByRole("button",{name:"그룹 만들기"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:"새로고침"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:"히어로 이미지 선택"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:"자동 인식 켜기"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:/후보 확인/})).not.toBeInTheDocument();
  const more=within(toolbar).getByRole("button",{name:"시리즈 더보기"});
  more.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("menuitem",{name:"시리즈 표지 선택"})).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(()=>expect(more).toHaveFocus());
  await user.click(more);
  await user.click(screen.getByRole("menuitem",{name:"시리즈 표지 선택"}));
  expect(screen.getByRole("region",{name:"갤러리 이미지 선택"})).toBeVisible();
  await user.click(screen.getByRole("button",{name:"취소"}));
  await user.click(within(toolbar).getByRole("button",{name:"캐릭터 만들기"}));
  expect(await screen.findByRole("dialog",{name:"새 캐릭터"})).toBeVisible();
});

it("creates a group from the series overflow",async()=>{
  await mount();
  const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"시리즈 더보기"}));
  await user.click(await screen.findByRole("menuitem",{name:"그룹 만들기"}));
  expect(await screen.findByRole("dialog",{name:"캐릭터 그룹 만들기"})).toBeVisible();
});

it("shows compact name-only tiles without a warning mark; a fallback to basic recognition is told in the description",async()=>{
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([{ targetId: "hina", reviewed: 30, wrong: 2, allowed: 1, examples: 60, status: "hold" }]);
  await mount();
  const hina=await screen.findByRole("button",{name:"히나 열기"});
  await waitFor(()=>expect(hina).toHaveAttribute("aria-description", expect.stringMatching(/^기본 인식으로 돌아감 · .*기본 인식 · 확인 판단 30 · 틀림 2/)));
  expect(hina.querySelector(".series-character__warning")).toBeNull();
  expect(hina.querySelector("small")).toBeEmptyDOMElement();
  expect(hina.querySelector("small")).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByText(/기본 인식/)).not.toBeInTheDocument();
  const kisaki=screen.getByRole("button",{name:"키사키 열기"});
  expect(kisaki.querySelector(".series-character__warning")).toBeNull();

  cleanup();
  await mount("hina");
  expect(await screen.findByText("기본 인식 · 확인 판단 30 · 틀림 2", { exact: false })).not.toHaveClass("series-character-status--warning");
});

it("keeps character selection in place without a persistent refresh button",async()=>{
  await mount("hina");
  const user=userEvent.setup();
  const toolbar=screen.getByRole("toolbar",{name:"시리즈 도구"});
  expect(within(toolbar).queryByRole("button",{name:"레퍼런스 추가"})).not.toBeInTheDocument();
  expect(within(toolbar).getByRole("button",{name:"캐릭터 편집"})).toBeVisible();
  expect(within(toolbar).queryByRole("button",{name:"새로고침"})).not.toBeInTheDocument();
  // A plain click focuses, as in plain folders (DESIGN §6); Ctrl+click selects.
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  expect(screen.getByRole("option",{name:"이미지 5.webp"})).toHaveAttribute("aria-selected","false");
  expect(screen.queryByRole("toolbar",{name:"선택 작업"})).not.toBeInTheDocument();
  await selectTile("이미지 5.webp");
  expect(screen.getByRole("option",{name:"이미지 5.webp"})).toHaveAttribute("aria-selected","true");
  const selectionBar=screen.getByRole("toolbar",{name:"선택 작업"});
  expect(within(selectionBar).getByRole("button",{name:"이 캐릭터에서 빼기"})).toBeVisible();
  expect(within(toolbar).getByRole("button",{name:"캐릭터 편집"})).toBeVisible();
});

it("keeps manual refresh available from the gallery context menu",async()=>{
  const {browse,changed}=await mount();
  const user=userEvent.setup();
  const item=await screen.findByRole("option",{name:"이미지 5.webp"});
  const calls=browse.mock.calls.length;
  await user.pointer({target:item,keys:"[MouseRight]"});
  for (const name of ["좋아요 켜기", "좋아요 끄기", "폴더로 이동", "불러온 이미지 선택", "선택 해제"]) {
    expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
  }
  await user.click(await screen.findByRole("menuitem",{name:"새로고침"}));
  await waitFor(()=>expect(browse.mock.calls.length).toBeGreaterThan(calls));
  expect(changed).toHaveBeenCalled();
});

it("creates an underfilled character as manual management",async()=>{
  const first=await mount(); const user=userEvent.setup();
  const manual={...(await first.api.targets())[0],id:"manual",displayName:"단역",manualOnly:true,ready:false,references:[]};
  vi.mocked(first.hubApi.createManualCharacter).mockResolvedValue(manual);
  await selectTile("이미지 5.webp");
  const selectionBar=screen.getByRole("toolbar",{name:"선택 작업"});
  await user.click(within(selectionBar).getByRole("button",{name:"캐릭터 지정"}));
  const search=await screen.findByRole("searchbox",{name:"캐릭터 찾기"});
  await user.type(search,"단역");
  await user.click(screen.getByRole("button",{name:'블루 아카이브에 “단역” 만들기'}));
  await waitFor(()=>expect(first.hubApi.createManualCharacter).toHaveBeenCalledWith({seriesId:"series",displayName:"단역",assetIds:["image-5"]}));
  expect(first.navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterId:"manual"});
});

it("keeps character selection in the header without review status",async()=>{
  const {api}=await mount("hina"); const user=userEvent.setup();
  const decide=vi.spyOn(api,"decide");
  expect(screen.queryByRole("button",{name:/검토/})).not.toBeInTheDocument();
  expect(screen.queryByText("0장 선택")).not.toBeInTheDocument();
  await selectTile("이미지 5.webp");
  const selectionBar=screen.getByRole("toolbar",{name:"선택 작업"});
  expect(within(selectionBar).getByText("1개 선택")).toBeInTheDocument();
  expect(document.querySelector(".series-gallery .series-selection")).toBeNull();
  await user.click(within(selectionBar).getByRole("button",{name:"이 캐릭터에서 빼기"}));
  await waitFor(()=>expect(decide).toHaveBeenCalledWith(expect.objectContaining({targetId:"hina",assetIds:["image-5"],decision:"rejected"})));
  expect(screen.queryByText("1개 선택")).not.toBeInTheDocument();
});

it("assigns multiple checked characters in one batch and clears only on success", async () => {
  const { api } = await mount();
  const user = userEvent.setup();
  const batch = vi.spyOn(api, "decideBatch").mockRejectedValueOnce(new Error("저장 실패"));
  await selectTile("이미지 5.webp");
  const selectionBar = screen.getByRole("toolbar", { name: "선택 작업" });
  await user.click(within(selectionBar).getByRole("button", { name: "캐릭터 지정" }));
  const picker = await screen.findByRole("listbox", { name: "캐릭터에 넣기" });
  fireEvent.click(within(picker).getByRole("option", { name: /히나/ }), { ctrlKey: true });
  fireEvent.click(within(picker).getByRole("option", { name: /키사키/ }), { ctrlKey: true });
  await user.click(within(picker).getByRole("button", { name: "2명에게 넣기" }));
  await screen.findByText("저장 실패");
  expect(within(picker).getByRole("option", { name: /히나/ })).toHaveAttribute("aria-selected", "true");
  expect(within(selectionBar).getByText("1개 선택")).toBeInTheDocument();
  batch.mockResolvedValueOnce(2);
  await user.click(within(picker).getByRole("button", { name: "2명에게 넣기" }));
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "캐릭터에 넣기" })).not.toBeInTheDocument());
  expect(batch).toHaveBeenLastCalledWith([
    expect.objectContaining({ targetId: "hina", assetIds: ["image-5"], decision: "accepted" }),
    expect.objectContaining({ targetId: "kisaki", assetIds: ["image-5"], decision: "accepted" }),
  ]);
});

it("keeps character assignment collapsed and filters the list on demand", async () => {
  await mount(); const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  await user.keyboard("c");
  const picker = await screen.findByRole("listbox", { name: "캐릭터에 넣기" });
  expect(screen.getByRole("button", { name: "블루 아카이브 범위 빼기" })).toBeVisible();
  const search = within(picker).getByRole("searchbox", { name: "캐릭터 찾기" });
  await user.type(search, "키사");
  expect(within(picker).getAllByRole("option", { name: /키사키/ })[0]).toBeInTheDocument();
  expect(within(picker).queryByRole("option", { name: /히나/ })).not.toBeInTheDocument();
});

it("opens the character editor from 편집 and keeps rare actions in 캐릭터 더보기", async () => {
  await mount("hina"); const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "캐릭터 편집" });
  expect(trigger.querySelector("path")?.getAttribute("d")).toContain("m16.862 4.487");
  await user.click(trigger);
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  const references = within(panel).getByRole("region", { name: "레퍼런스 목록" });
  expect(references.closest("details")).toBeNull();
  expect(within(panel).getByRole("button", { name: "레퍼런스 추가" }).closest("details")).toBeNull();
  expect(within(references).getByRole("button", { name: "레퍼런스 1 제거" })).toBeVisible();
  expect(within(panel).getByText("관리", { selector: "summary span" })).toBeVisible();
  expect(within(panel).queryByRole("button", { name: "과거 미분류 이미지 갱신" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "일반 폴더로 전환" })).not.toBeInTheDocument();
  expect(within(panel).queryByText("자동 인식 끄기")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "캐릭터 더보기" })).toBeVisible();
  expect(within(panel).queryByText("분류 안내")).not.toBeInTheDocument();
  expect(within(panel).queryByText("추가 관리")).not.toBeInTheDocument();
  expect(within(panel).getByText(/^자동 인식 켜짐/)).toBeVisible();
  expect(within(panel).getByRole("button", { name: "저장" })).toBeVisible();
});

it("hides routine per-character participation controls", async () => {
  await mount("hina"); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(within(panel).queryByRole("checkbox", { name: "자동 분석에 사용" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "자동 인식 켜기" })).not.toBeInTheDocument();
});

it("offers recovery when a legacy character is disabled", async () => {
  await mount("hina", false, [], undefined, false, { targetEnabled: false }); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "자동 인식 켜기" }));
  expect(within(panel).queryByRole("button", { name: "자동 인식 켜기" })).not.toBeInTheDocument();
});


it("opens suggested reference reinforcement from character settings and refreshes after applying", async () => {
  // First setup only: a character with fewer than five base references still fills itself through the dialog.
  const references = Array.from({ length: 3 }, (_, slot) => ({ slot, assetId: `image-${slot}`, assetHash: `hash-${slot}`, status: "ready" }));
  const { hubApi, changed } = await mount("hina", false, [], undefined, false, { targetOverrides: { references } });
  const user = userEvent.setup();
  const toolbar = screen.getByRole("toolbar", { name: "시리즈 도구" });
  expect(within(toolbar).queryByRole("button", { name: "추천으로 보강" })).not.toBeInTheDocument();
  await user.click(within(toolbar).getByRole("button", { name: "캐릭터 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "추천으로 보강" }));

  expect(await screen.findByRole("dialog", { name: "레퍼런스 선택" })).toBeVisible();
  await waitFor(() => expect(hubApi.referenceCandidates).toHaveBeenCalledWith("hina", 20));
  await user.click(screen.getByRole("button", { name: "2장 적용" }));
  await waitFor(() => expect(hubApi.confirmReferenceBatch).toHaveBeenCalledWith(expect.objectContaining({
    targetId: "hina",
    confirmationMode: "add_learned",
    assetIds: ["image-5", "image-6"],
  })));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(screen.queryByRole("dialog", { name: "레퍼런스 선택" })).not.toBeInTheDocument();
});

it("opens manual reference selection from the character folder and saves only the chosen images", async () => {
  const { api, browse, hubApi } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await openReferencePicker(user);
  expect(await screen.findByRole("region", { name: "갤러리 이미지 선택" })).toBeVisible();
  expect(screen.getByText("레퍼런스 선택 · 5/25")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: "hina", referenceTargetId: "hina", all: true })));
  expect(hubApi.referenceCandidates).not.toHaveBeenCalled();
  const candidate = await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(candidate).toHaveAttribute("aria-selected", "false");
  await user.click(candidate);
  await user.click(screen.getByRole("button", { name: "완료" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(save).not.toHaveBeenCalled();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "hina", referenceIds: fixtureAssets.slice(0, 6).map(asset => asset.id) }), true));
  expect(hubApi.confirmReferenceBatch).not.toHaveBeenCalled();
});

it("starts historical refresh only after explicit confirmation", async () => {
  const { hubApi } = await mount("hina"); const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const refresh = await screen.findByRole("menuitem", { name: "과거 미분류 이미지 갱신" });
  await user.click(refresh);
  expect(hubApi.requestReferenceRefresh).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  await user.click(await screen.findByRole("menuitem", { name: "과거 미분류 이미지 갱신" }));
  await waitFor(() => expect(hubApi.requestReferenceRefresh).toHaveBeenCalledWith("hina", 1));
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("미분류 이미지 전체"));
  expect(await screen.findByText("미분류 이미지 12개 갱신을 예약했습니다. 작업 센터에서 진행 상황을 확인할 수 있습니다.")).toBeVisible();
});

it("limits an existing character portrait picker to its own folder", async () => {
  const { browse } = await mount("hina");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByText("관리"));
  await user.click(within(panel).getByRole("button", { name: "대표 이미지 선택" }));
  await waitFor(() => expect(browse).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", referenceTargetId: "hina", all: true })));
  expect(screen.getByRole("heading", { name: /히나 소속/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "미분류만 보기" })).not.toBeInTheDocument();
});

it("allows reference selection from the series after opening the character folder", async () => {
  const {browse}=await mount("hina"); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 편집"}));
  const panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.click(within(panel).getByText("관리"));
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await user.click(await screen.findByRole("button",{name:"시리즈에서 이미지 찾기"}));
  await waitFor(()=>expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({targetId:null,referenceTargetId:"hina"})));
  const callsBeforeReturn=browse.mock.calls.length;
  await user.click(screen.getByRole("button",{name:"소속으로 돌아가기"}));
  await screen.findByRole("heading",{name:/히나 소속/});
  expect(browse).toHaveBeenCalledTimes(callsBeforeReturn);
});

it("shows only character states that need attention on overview cards", async () => {
  await mount();
  await screen.findByRole("button", { name: "히나 열기" });
  expect(screen.queryByLabelText("레퍼런스 준비 완료")).not.toBeInTheDocument();
});

it("places ordinary folders beside characters with navigation and no classification-exclusion UI", async () => {
  const { navigate } = await mount(undefined, false, [], undefined, false, {
    folders: [{ classificationId: "machines", thumbnailAssetId: "asset-5" }], privacyMode: true,
  });
  const card = await screen.findByRole("button", { name: "기체 폴더 열기" });
  expect(card.closest(".series-characters")).toContainElement(screen.getByRole("button", { name: "히나 열기" }));
  expect(card.querySelector("img")).toBeNull();
  expect(card.querySelector(".privacy-mask")).toHaveAttribute("aria-label", "비공개 모드");
  expect(screen.getByRole("button", {name: "히나 열기"}).querySelector("img[src]")).toBeNull();
  const user = userEvent.setup();
  expect(card).toHaveAttribute("aria-description", "일반 폴더");
  expect(within(card).queryByText("제외")).not.toBeInTheDocument();
  expect(card.closest("article")).not.toHaveTextContent("분류 제외");
  expect(screen.queryByRole("button", { name: "기체 폴더 더보기" })).not.toBeInTheDocument();
  expect(screen.queryByText("분류 제외")).not.toBeInTheDocument();
  await user.click(card);
  expect(navigate).toHaveBeenCalledWith({ kind: "classification", classificationId: "machines" });
});


it("copies a character asset source and reports clipboard failures without changing the gallery", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const { changed } = await mount("hina", false, [], undefined, false, { sourceUrl: "https://example.com/pilot" });
  const item = await screen.findByRole("option", { name: "이미지 5.webp" });
  await user.pointer({ target: item, keys: "[MouseRight]" });
  await user.click(screen.getByRole("menuitem", { name: "출처 복사" }));
  expect(writeText).toHaveBeenCalledWith("https://example.com/pilot");
  expect(await screen.findByText("출처를 복사했습니다.")).toBeVisible();
  writeText.mockRejectedValueOnce(undefined);
  await user.pointer({ target: item, keys: "[MouseRight]" });
  await user.click(screen.getByRole("menuitem", { name: "출처 복사" }));
  expect(await screen.findByText("출처를 복사하지 못했습니다.")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
});

// Region inspection is optional and draft-only: it never saves, and it never
// blocks the ordinary character settings flow.
function inspection(assetId: string, state: string, boxes: [number, number, number, number][] = [[10, 20, 110, 220]]) {
  return { assetId, contentHash: `hash-${assetId}`, baselineFingerprint: "baseline", width: 400, height: 600, boxes,
    selectedIndex: null, suggestedIndex: null, automaticIndex: state === "automatic" ? 0 : null, state };
}

async function openReferences(inspect?: (seriesId: string, targetId: string | null, assetIds: string[], regions?: Record<string, unknown>) => Promise<unknown[]>) {
  const user = userEvent.setup();
  const mounted = await mount(undefined, false, [], undefined, false, inspect ? { inspect } : {});
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  return { ...mounted, user, panel };
}

it("marks required person confirmation before opening info, shares inspection, and restores the mark when edits are discarded", async () => {
  const inspect = vi.fn(async (_series: string, _target: string | null, ids: string[], regions?: Record<string, unknown>) =>
    ids.map((id, index) => index === 0 && !regions?.[id]
      ? inspection(id, "needs_region", [[0, 0, 100, 200], [100, 0, 200, 200]]) : inspection(id, "single")));
  await mount("hina", false, [], undefined, false, { inspect });
  const user = userEvent.setup();
  const info = await screen.findByRole("button", { name: "캐릭터 편집" });
  // A neutral count on the pencil, not a red mark.
  await waitFor(() => expect(within(info).getByText("1")).toBeInTheDocument());
  expect(info.querySelector(".character-info-count")).toHaveClass("ui-badge--corner");
  expect(info).toHaveAttribute("aria-description", "필요한 인물 확인이 있습니다.");
  expect(screen.queryByRole("dialog", { name: "히나 · 캐릭터 정보" })).not.toBeInTheDocument();
  expect(inspect).toHaveBeenCalledTimes(1);
  await user.click(info);
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(await within(panel).findByRole("button", { name: "인물 선택 1" }));
  expect(inspect).toHaveBeenCalledTimes(1);
  await user.click(within(panel).getByRole("button", { name: "인물 영역 1 선택" }));
  await waitFor(() => expect(info.querySelector(".character-info-count")).toBeNull());
  expect(inspect).toHaveBeenCalledTimes(2);
  await user.click(within(panel).getByRole("button", { name: "히나 · 캐릭터 정보 닫기" }));
  await waitFor(() => expect(within(info).getByText("1")).toBeInTheDocument());
});

it("does not mark optional correction when six references are usable", async () => {
  const references = Array.from({ length: 7 }, (_, slot) => ({ slot, assetId: `image-${slot}`, assetHash: `hash-${slot}`, status: "ready" }));
  const inspect = vi.fn(async (_series: string, _target: string | null, ids: string[]) => ids.map((id, index) =>
    inspection(id, index === 6 ? "needs_region" : "single")));
  await mount("hina", false, [], undefined, false, { inspect, targetOverrides: { references } });
  const info = await screen.findByRole("button", { name: "캐릭터 편집" });
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
  expect(info.querySelector(".character-info-count")).toBeNull();
  await userEvent.setup().click(info);
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(within(panel).queryByRole("button", { name: "인물 선택 1" })).not.toBeInTheDocument();
  expect(inspect).toHaveBeenCalledTimes(1);
});

it("describes a failed inspection on the pencil and clears it after retrying from the status slot", async () => {
  const inspect = vi.fn().mockRejectedValueOnce(new Error("인물 확인 실패"))
    .mockImplementation(async (_series: string, _target: string | null, ids: string[]) => ids.map(id => inspection(id, "single")));
  await mount("hina", false, [], undefined, false, { inspect });
  const info = await screen.findByRole("button", { name: "캐릭터 편집" });
  await waitFor(() => expect(info).toHaveAttribute("aria-description", expect.stringContaining("확인 실패")));
  expect(info.querySelector(".character-info-count")).toBeNull();
  const user = userEvent.setup();
  await user.click(info);
  await user.click(await screen.findByRole("button", { name: "확인 실패 · 다시 시도" }));
  await waitFor(() => expect(info).toHaveAttribute("aria-description", "캐릭터 정보 편집"));
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
});

it.each([{ targetEnabled: false }, { targetOverrides: { manualOnly: true } }])("does not inspect disabled or manual-only characters for the badge: %j", async options => {
  const inspect = vi.fn(async () => []);
  await mount("hina", false, [], undefined, false, { ...options, inspect });
  const info = await screen.findByRole("button", { name: "캐릭터 편집" });
  expect(info.querySelector(".character-info-count")).toBeNull();
  expect(inspect).not.toHaveBeenCalled();
});

it("sends only changed manual regions so unchanged settings do not require detector validation", () => {
  const original: ReferenceRegion = { contentHash: "hash", baselineFingerprint: "baseline", bounds: [0, 0, 40, 50] };
  const saved = { a: original };
  expect(draftReferenceRegions({ a: { ...original, bounds: [...original.bounds] } }, ["a"], saved)).toEqual({});
  const changed: ReferenceRegion = { ...original, bounds: [40, 0, 80, 50] };
  expect(draftReferenceRegions({ a: changed, removed: original }, ["a"], saved)).toEqual({ a: changed });
  expect(draftReferenceRegions({ a: { ...original, baselineFingerprint: "new" } }, ["a"], saved)).toHaveProperty("a");
  expect(draftReferenceRegions({ a: { ...original, contentHash: "new" } }, ["a"], saved)).toHaveProperty("a");
});

it("never prompts for unambiguous references and still inspects read-only", async () => {
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[]) => assetIds.map(id => inspection(id, "single")));
  const mounted = await mount(undefined, false, [], undefined, false, { inspect });
  const saveSettings = vi.spyOn(mounted.api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  // Five single-person references leave nothing to ask, so the section stays out of the way.
  await waitFor(() => expect(inspect).toHaveBeenCalledWith("series", "hina", expect.arrayContaining(["image-0"]), {}));
  expect(within(panel).queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "인물 선택 1" })).not.toBeInTheDocument();
  expect(saveSettings).not.toHaveBeenCalled();
  expect(mounted.changed).not.toHaveBeenCalled();
});

it("asks for one unresolved reference and stores the choice in the draft only", async () => {
  // A multi-person image keeps its boxes after a choice, so the region stays replaceable.
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[]) =>
    assetIds.map(id => id === "image-0"
      ? inspection(id, "needs_region", [[10, 20, 110, 220], [200, 40, 380, 520]])
      : inspection(id, "single")));
  const mounted = await mount(undefined, false, [], undefined, false, { inspect });
  const saveSettings = vi.spyOn(mounted.api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(await within(panel).findByRole("button", { name: "인물 선택 1" }));
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 2 선택" }));
  // The correction list is reached only through the optional adjustment action.
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 조정" }));
  const regions = await within(panel).findByRole("region", { name: "인물 영역 목록" });
  expect(within(regions).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" })).toBeInTheDocument();
  // Choosing a region changes the draft only; nothing is written until save.
  expect(saveSettings).not.toHaveBeenCalled();
  expect(mounted.changed).not.toHaveBeenCalled();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ referenceRegions: { "image-0": { contentHash: "hash-image-0", baselineFingerprint: "baseline", bounds: [200, 40, 380, 520] } } }), true));
});

const sharedFirst = (two: [number, number, number, number][]) => async (_seriesId: string, _targetId: string | null, assetIds: string[], regions?: Record<string, unknown>) =>
  assetIds.map(id => id !== "image-0" ? inspection(id, "single")
    : regions?.[id] ? { ...inspection(id, "selected", two), selectedIndex: 1, otherCharacters: ["자오"] }
    : { ...inspection(id, "needs_region", two), suggestedIndex: 0, otherCharacters: ["자오"] });

it("names a save blocked on a shared image's person before saving, and opens that chooser instead of failing", async () => {
  const two: [number, number, number, number][] = [[10, 20, 110, 220], [200, 40, 380, 520]];
  const inspect = vi.fn(sharedFirst(two));
  const { api, user, panel } = await openReferences(inspect);
  const save = vi.spyOn(api, "saveSettings");
  await within(panel).findByRole("button", { name: "인물 선택 1" });
  // Before anything is pressed: the footer says what the save waits for, in normal text, with no alert.
  const status = await within(panel).findByText("레퍼런스 1 · 인물 선택 후 저장");
  expect(status).toHaveAttribute("role", "status");
  expect(status).toHaveClass("character-foot-status--blocking");
  const registry = within(within(panel).getByRole("region", { name: "캐릭터 설정" }));
  expect(registry.queryByRole("alert")).not.toBeInTheDocument();
  // 저장 stays enabled; pressing it opens that reference's chooser and writes nothing.
  expect(within(panel).getByRole("button", { name: "저장" })).toBeEnabled();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  expect(save).not.toHaveBeenCalled();
  expect(await within(panel).findByRole("region", { name: "인물 영역 확인" })).toBeVisible();
  expect(registry.queryByRole("alert")).not.toBeInTheDocument();
  // The right person (not 자오's) is chosen: the footer line and the mark go, and the save goes through.
  await user.click(within(panel).getByRole("button", { name: "인물 영역 2 선택" }));
  await waitFor(() => expect(within(panel).queryByText(/인물 선택 후 저장/)).not.toBeInTheDocument());
  await waitFor(() => expect(within(panel).getByRole("button", { name: /레퍼런스 1 크롭 확인/ }).parentElement!.querySelector(".character-reference-tile__mark")).toBeNull());
  expect(within(panel).getByText(/사용 가능 5장/)).toBeInTheDocument();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
});

it("still shows a real save failure as the one-line error", async () => {
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[]) => assetIds.map(id => inspection(id, "single")));
  const { api, user, panel } = await openReferences(inspect);
  vi.spyOn(api, "saveSettings").mockRejectedValueOnce(new Error("서버가 응답하지 않습니다."));
  await waitFor(() => expect(inspect).toHaveBeenCalled());
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  expect(await within(within(panel).getByRole("region", { name: "캐릭터 설정" })).findByRole("alert")).toHaveTextContent("서버가 응답하지 않습니다.");
});

it("keeps 추천으로 보강 out of the panel of a character that already has its base references", async () => {
  await mount("hina");
  await userEvent.setup().click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(within(panel).getByRole("button", { name: "레퍼런스 추가" })).toBeVisible();
  expect(within(panel).queryByRole("button", { name: "추천으로 보강" })).not.toBeInTheDocument();
});

const pendingRun = { runId: "run-1", assetIds: ["image-3", "image-4"], at: "2026-10-13T00:00:00Z" };

async function openReinforced(ghosts: unknown[] = []) {
  const mounted = await mount("hina");
  const reinforcement = vi.fn(async () => ({ pendingRun, ghosts }));
  const acknowledge = vi.fn(async () => null);
  const undo = vi.fn(async (_targetId: string, _runId: string) => ({ ...mounted.targets.find(t => t.id === "hina")!, revision: 2, fingerprint: "after-undo",
    references: mounted.targets.find(t => t.id === "hina")!.references.slice(0, 3) }));
  Object.assign(mounted.api, { referenceReinforcement: reinforcement, acknowledgeReferenceReinforcement: acknowledge, undoReferenceReinforcement: undo });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  return { ...mounted, user, panel, reinforcement, acknowledge, undo };
}

it("shows the reinforcement line, undoes it without a blank frame, and does not acknowledge an undone run", async () => {
  const { user, panel, undo, acknowledge, changed, reinforcement } = await openReinforced();
  expect(await within(panel).findByText("2장 보강됨")).toBeVisible();
  expect(reinforcement).toHaveBeenCalledWith("hina");
  const strip = within(panel).getByRole("region", { name: "레퍼런스 목록" });
  expect(strip.querySelectorAll(".character-reference-tile")).toHaveLength(5);
  await user.click(within(panel).getByRole("button", { name: "되돌리기" }));
  expect(undo).toHaveBeenCalledWith("hina", "run-1");
  // The strip lost exactly the run's tiles and the line left, with the panel still open and clean.
  await waitFor(() => expect(within(panel).queryByText(/보강됨/)).not.toBeInTheDocument());
  expect(strip.querySelectorAll(".character-reference-tile")).toHaveLength(3);
  expect(within(panel).queryByText("저장하지 않은 변경")).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalled();
  await user.click(within(panel).getByRole("button", { name: "히나 · 캐릭터 정보 닫기" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "히나 · 캐릭터 정보" })).not.toBeInTheDocument());
  expect(acknowledge).not.toHaveBeenCalled();
});

it("acknowledges a seen run once when the panel is closed, and not again when it is reopened", async () => {
  const { user, panel, acknowledge } = await openReinforced();
  await within(panel).findByText("2장 보강됨");
  expect(acknowledge).not.toHaveBeenCalled();
  await user.click(within(panel).getByRole("button", { name: "히나 · 캐릭터 정보 닫기" }));
  await waitFor(() => expect(acknowledge).toHaveBeenCalledWith("hina", "run-1"));
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const reopened = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await within(reopened).findByText("2장 보강됨");
  await user.click(within(reopened).getByRole("button", { name: "히나 · 캐릭터 정보 닫기" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "히나 · 캐릭터 정보" })).not.toBeInTheDocument());
  expect(acknowledge).toHaveBeenCalledTimes(1);
});

it("acknowledges a seen run when the panel is saved", async () => {
  const { user, panel, acknowledge, api } = await openReinforced();
  const save = vi.spyOn(api, "saveSettings");
  await within(panel).findByText("2장 보강됨");
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  await waitFor(() => expect(acknowledge).toHaveBeenCalledWith("hina", "run-1"));
  expect(acknowledge).toHaveBeenCalledTimes(1);
});

it("adds a suggested reference to the draft with its region and writes it only with the panel's own 저장", async () => {
  const region = { contentHash: "hash-image-8", baselineFingerprint: "baseline", bounds: [5, 6, 70, 80] as [number, number, number, number] };
  const { user, panel, api } = await openReinforced([{ assetId: "image-8", hash: "hash-image-8", persons: 1, safe: true, region }]);
  const save = vi.spyOn(api, "saveSettings");
  await user.click(await within(panel).findByRole("button", { name: "추천 레퍼런스 1 추가" }));
  expect(within(panel).getByText("저장하지 않은 변경")).toBeVisible();
  expect(save).not.toHaveBeenCalled();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
    referenceIds: ["image-0", "image-1", "image-2", "image-3", "image-4", "image-8"],
    referenceRegions: { "image-8": region },
  }), true));
});

it("drops suggestions that were not added when the panel is closed without saving", async () => {
  const { user, panel, api } = await openReinforced([{ assetId: "image-8", hash: "hash-image-8", persons: 1, safe: true }]);
  const save = vi.spyOn(api, "saveSettings");
  await user.click(await within(panel).findByRole("button", { name: "추천 레퍼런스 1 추가" }));
  await user.click(within(panel).getByRole("button", { name: "히나 · 캐릭터 정보 닫기" }));
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const reopened = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(await within(reopened).findByRole("button", { name: "추천 레퍼런스 1 추가" })).toBeVisible();
  expect(save).not.toHaveBeenCalled();
});

it("keeps asking only through the quiet button until the requirement is met", async () => {
  const calls: { regions: Record<string, unknown> }[] = [];
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[], regions?: Record<string, unknown>) => {
    calls.push({ regions: { ...regions } });
    // Five references plus one extra: six usable references is only reached after a pick.
    return [...assetIds, "image-extra"].map(id => regions?.[id] ? inspection(id, "selected")
      : id === "image-0" ? inspection(id, "needs_region", [[10, 20, 110, 220], [200, 40, 380, 520]]) : inspection(id, "single"));
  });
  const { user, panel } = await openReferences(inspect);
  // The chooser is closed until the user asks for it.
  expect(within(panel).queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  await user.click(await within(panel).findByRole("button", { name: "인물 선택 1" }));
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 2 선택" }));
  // The confirmed choice is included in the next inspection request.
  await waitFor(() => expect(calls.some(call => call.regions["image-0"])).toBe(true));
  // Six usable references are reached, so the requirement becomes an optional correction.
  expect(await within(panel).findByRole("button", { name: "인물 영역" })).toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "인물 선택 1" })).not.toBeInTheDocument();
});

it("keeps a manual region choice for replacement and drops it when its reference is removed", async () => {
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[]) =>
    assetIds.map(id => id === "image-0" ? inspection(id, "needs_region", [[10, 20, 110, 220], [200, 40, 380, 520]]) : inspection(id, "single")));
  const mounted = await mount(undefined, false, [], undefined, false, { inspect });
  const saveSettings = vi.spyOn(mounted.api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(await within(panel).findByRole("button", { name: "인물 선택 1" }));
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 2 선택" }));
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 조정" }));
  const regions = await within(panel).findByRole("region", { name: "인물 영역 목록" });
  expect(within(regions).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" })).toBeInTheDocument();
  // Removing the reference also drops the region that belonged to it.
  await user.click(within(panel).getByRole("button", { name: "레퍼런스 1 제거" }));
  await waitFor(() => expect(within(panel).queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument());
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  // The removed reference's region is never saved back.
  await waitFor(() => expect(saveSettings).toHaveBeenCalled());
  expect(saveSettings).not.toHaveBeenCalledWith(expect.objectContaining({ referenceRegions: expect.objectContaining({ "image-0": expect.anything() }) }), true);
});

it("skips region inspection entirely when the host does not expose it", async () => {
  const mounted = await mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(within(panel).queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
  expect(mounted.api.inspectReferenceRegions).toBeUndefined();
});

it("opens the 확인 list from the series count line, not the series overflow", async () => {
  const { confirmSource } = await mount(undefined, false, [], undefined, false, { candidates: 1, shadowItems: ["a1"] });
  const user = userEvent.setup();
  await screen.findByRole("radiogroup", { name: "시리즈 이미지 필터" });
  expect(screen.queryByRole("radiogroup", { name: "자동 분류 방식" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "시리즈 더보기" }));
  // The duplicate entries are gone: no S36 시험 채점 확인, no separate 확인 item in the overflow.
  expect(screen.queryByRole("menuitem", { name: "확인" })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(await screen.findByRole("button", { name: "확인 1" }));
  const dialog = await screen.findByRole("dialog", { name: "확인" });
  expect(await within(dialog).findByRole("button", { name: "히나 · a1.png" })).toBeInTheDocument();
  expect(confirmSource.shadow.page).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series" }));
  await user.click(within(dialog).getByRole("button", { name: "확인 닫기" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "확인" })).not.toBeInTheDocument());
});

it("shows waiting items as a quiet action on the series count line, not a banner", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  const { confirmSource } = await mount(undefined, false, [], undefined, false, { candidates: 37, shadowItems: ["a1"] });
  const user = userEvent.setup();
  const review = await screen.findByRole("button", { name: "확인 37" });
  expect(confirmSource.counts).toHaveBeenCalledWith("series");
  expect(review).not.toHaveClass("ui-button--primary");
  expect(screen.queryByRole("region", { name: "확인할 후보" })).not.toBeInTheDocument();
  const heading = review.closest(".character-group-heading")!;
  expect(heading).toHaveTextContent("캐릭터 2");
  const toolbar = screen.getByRole("toolbar", { name: "시리즈 도구" });
  expect(within(toolbar).queryByRole("button", { name: /후보/ })).not.toBeInTheDocument();
  await user.click(review);
  // The count and the list it opens cover only this series' characters.
  const dialog = await screen.findByRole("dialog", { name: "확인" });
  expect(within(dialog).getByText("블루 아카이브")).toHaveClass("confirm-list__scope");
  await waitFor(() => expect(confirmSource.shadow.page).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series" })));
  expect(vi.mocked(confirmSource.shadow.page).mock.calls.every(([query]) => (query as { seriesId?: string }).seriesId === "series")).toBe(true);
});

it("hides the 확인 action inside a character", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  await mount("hina", false, [], undefined, false, { candidates: 37 });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(screen.queryByRole("button", { name: /확인 [0-9]/ })).not.toBeInTheDocument();
});

it("shows 확인 on a series that does not use 학습 인식 too, so judgments can pile up everywhere", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  const { confirmSource } = await mount(undefined, false, [], undefined, false, { candidates: 37 });
  expect(await screen.findByRole("button", { name: "확인 37" })).toBeInTheDocument();
  expect(confirmSource.counts).toHaveBeenCalledWith("series");
});

it("hides 확인 when nothing waits", async () => {
  const { confirmSource } = await mount(undefined);
  await waitFor(() => expect(confirmSource.counts).toHaveBeenCalledWith("series"));
  expect(screen.queryByRole("button", { name: /확인 [0-9]/ })).not.toBeInTheDocument();
});

it("moves FAULT into the series overflow and offers no recognition selector", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  await mount(undefined, false, [], undefined, false, { fault: true });
  const user = userEvent.setup();
  const toolbar = screen.getByRole("toolbar", { name: "시리즈 도구" });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(within(toolbar).queryByRole("button", { name: "이 묶음으로 플레이" })).not.toBeInTheDocument();
  expect(screen.queryByRole("status", { name: /S36/ })).not.toBeInTheDocument();
  await user.click(within(toolbar).getByRole("button", { name: "시리즈 더보기" }));
  expect(await screen.findByRole("menuitem", { name: "FAULT로 플레이" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "확인" })).not.toBeInTheDocument();
  // Each character is placed by 기본 인식 or 학습 인식 by itself: nothing to choose per series.
  expect(screen.queryByRole("menuitem", { name: "학습 인식 설정" })).not.toBeInTheDocument();
  expect(screen.queryByRole("radiogroup", { name: "자동 분류 방식" })).not.toBeInTheDocument();
});

it("turns a character's automatic recognition off from 캐릭터 더보기 and nothing else changes", async () => {
  const { api } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "자동 인식 끄기" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "hina", expectedRevision: 1, enabled: false, displayName: "히나" }), true));
  expect(screen.queryByRole("menuitem", { name: "학습 인식 설정" })).not.toBeInTheDocument();
});

it("reaches each reference's crop check in one tap from the character panel and saves the choice", async () => {
  const inspect = vi.fn(async (_series: string, _target: string | null, ids: string[]) => ids.map(id => id === "image-2"
    ? inspection(id, "automatic", [[0, 0, 100, 200], [100, 0, 200, 200]]) : inspection(id, "single")));
  const { api } = await mount("hina", false, [], undefined, false, { inspect });
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  const list = within(panel).getByRole("region", { name: "레퍼런스 목록" });
  await user.click(await within(list).findByRole("button", { name: "레퍼런스 3 크롭 확인" }));
  await user.click(within(panel).getByRole("button", { name: "인물 영역 2 선택" }));
  expect(within(panel).getByText("저장하지 않은 변경")).toBeVisible();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
    referenceRegions: { "image-2": { contentHash: "hash-image-2", baselineFingerprint: "baseline", bounds: [100, 0, 200, 200] } },
  }), true));
});

it("hearts a series tile in place without reloading the series screen", async () => {
  const setAssetFavorite = vi.fn().mockResolvedValue(undefined);
  const characterSidebarCounts = vi.fn().mockResolvedValue({ targets: {} });
  const listSuggestions = vi.spyOn(suggestionApi, "list");
  const { browse, changed } = await mount(undefined, false, [], undefined, false, { gateway: { setAssetFavorite, characterSidebarCounts } });
  const tile = await screen.findByRole("option", { name: "이미지 5.webp" });
  await waitFor(() => expect(characterSidebarCounts).toHaveBeenCalled());
  const reads = { browse: browse.mock.calls.length, counts: characterSidebarCounts.mock.calls.length, suggestions: listSuggestions.mock.calls.length };
  await userEvent.click(within(tile).getByRole("button", { name: "이미지 5.webp 좋아요" }));
  await waitFor(() => expect(within(screen.getByRole("option", { name: "이미지 5.webp" })).getByRole("button", { name: "이미지 5.webp 좋아요" })).toHaveAttribute("aria-pressed", "true"));
  expect(setAssetFavorite).toHaveBeenCalledWith("image-5", true);
  expect(browse.mock.calls.length).toBe(reads.browse);
  expect(characterSidebarCounts.mock.calls.length).toBe(reads.counts);
  expect(listSuggestions.mock.calls.length).toBe(reads.suggestions);
  expect(changed).not.toHaveBeenCalled();
});

it("trashes from the series in place and puts the tile back on 실행 취소", async () => {
  const trashAssets = vi.fn().mockResolvedValue(undefined), restoreAssets = vi.fn().mockResolvedValue(undefined);
  const { browse, changed } = await mount(undefined, false, [], undefined, false, { gateway: { trashAssets, restoreAssets } });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  const reads = browse.mock.calls.length;
  await selectTile("이미지 6.webp");
  await userEvent.click(within(screen.getByRole("toolbar", { name: "선택 작업" })).getByRole("button", { name: "휴지통으로" }));
  await waitFor(() => expect(screen.queryByRole("option", { name: "이미지 6.webp" })).toBeNull());
  expect(trashAssets).toHaveBeenCalledWith(["image-6"]);
  await userEvent.click(screen.getByRole("button", { name: "실행 취소" }));
  await waitFor(() => expect(screen.getByRole("option", { name: "이미지 6.webp" })).toBeInTheDocument());
  expect(restoreAssets).toHaveBeenCalledWith(["image-6"]);
  expect([...document.querySelectorAll("[data-asset-id]")].map(node => node.getAttribute("data-asset-id")).slice(0, 3)).toEqual(["image-5", "image-6", "image-7"]);
  expect(browse.mock.calls.length).toBe(reads);
  expect(changed).not.toHaveBeenCalled();
});

it("offers 이 캐릭터에서 빼기 in the viewer opened from a character, but not on its references", async () => {
  const { api } = await mount("hina");
  const decide = vi.spyOn(api, "decide");
  await userEvent.dblClick(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const exclude = await screen.findByRole("button", { name: "이 캐릭터에서 빼기" });
  expect(screen.getByRole("button", { name: "캐릭터" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "정보" })).toBeInTheDocument();
  await userEvent.click(exclude);
  await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", assetIds: ["image-5"], decision: "rejected" })));
  cleanup();
  await mount("hina", false, [], undefined, false, { targetOverrides: { references: [{ slot: 0, assetId: "image-5", assetHash: "hash-image-5", status: "ready" }] } });
  await userEvent.dblClick(await screen.findByRole("option", { name: "이미지 5.webp" }));
  await screen.findByRole("button", { name: "정보" });
  expect(screen.queryByRole("button", { name: "이 캐릭터에서 빼기" })).toBeNull();
});

it("hides date headings under the series shelf and shows them in a character", async () => {
  await mount();
  await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(document.querySelector("[data-gallery-date]")).toBeNull();
  cleanup();
  await mount("hina");
  await screen.findByRole("option", { name: "이미지 5.webp" });
  await waitFor(() => expect(document.querySelector("[data-gallery-date]")).not.toBeNull());
});

// A single click only focuses a tile; double click or Enter opens the viewer (DESIGN §6–7), in the
// series root, a group and a character alike.
it.each([
  ["series root", undefined, undefined],
  ["group", undefined, "group"],
  ["character", "hina", undefined],
])("focuses on a single click and opens the viewer only on double click or Enter: %s", async (_label, targetId, groupId) => {
  await mount(targetId, false, groupId ? [{ id: groupId, name: "Group", seriesId: "series", revision: 1, targetIds: ["kisaki", "hina"] }] : [], groupId);
  const user = userEvent.setup();
  const tile = await screen.findByRole("option", { name: "이미지 5.webp" });
  await user.click(tile);
  await waitFor(() => expect(screen.getByRole("option", { name: "이미지 5.webp" })).toHaveAttribute("data-focused", "true"));
  expect(screen.getByRole("option", { name: "이미지 5.webp" })).toHaveAttribute("aria-selected", "false");
  expect(screen.queryByRole("button", { name: "감상 화면 닫기" })).toBeNull();
  await user.dblClick(screen.getByRole("option", { name: "이미지 5.webp" }));
  await user.click(await screen.findByRole("button", { name: "감상 화면 닫기" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "감상 화면 닫기" })).toBeNull());
  screen.getByRole("option", { name: "이미지 5.webp" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: "감상 화면 닫기" })).toBeInTheDocument();
});

// Double-clicking a character card (Explorer habit): the first click opens the character and the
// second lands on a tile that has just appeared under the pointer. Chromium still fires dblclick on
// that tile, which must not open the viewer; a real double click on the tile still does.
it("does not open a tile from a double click whose first click opened the character", async () => {
  const mounted = await mount();
  mounted.navigate.mockImplementation(view => { if (view.characterId) mounted.navigateToCharacter(view.characterId); });
  const card = await screen.findByRole("button", { name: "히나 열기" });
  fireEvent.mouseDown(card, { detail: 1 }); fireEvent.mouseUp(card, { detail: 1 }); fireEvent.click(card, { detail: 1 });
  await waitFor(() => expect(screen.queryByRole("button", { name: "히나 열기" })).toBeNull());
  const tile = await screen.findByRole("option", { name: "이미지 5.webp" });
  fireEvent.mouseDown(tile, { detail: 2 }); fireEvent.mouseUp(tile, { detail: 2 }); fireEvent.click(tile, { detail: 2 }); fireEvent.doubleClick(tile, { detail: 2 });
  expect(screen.queryByRole("button", { name: "감상 화면 닫기" })).toBeNull();
  for (const detail of [1, 2]) { fireEvent.mouseDown(tile, { detail }); fireEvent.mouseUp(tile, { detail }); fireEvent.click(tile, { detail }); }
  fireEvent.doubleClick(tile, { detail: 2 });
  expect(await screen.findByRole("button", { name: "감상 화면 닫기" })).toBeInTheDocument();
});
