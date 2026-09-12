import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { type CharacterGroup, type CharacterHubApi, type SeriesFolder } from "./hubApi";
import { ChromeSettingsDock, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";

beforeEach(() => { Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable:true,get:()=>850 },clientHeight:{configurable:true,get:()=>650} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("can select and save a sixth reference without a separate additional-reference workflow", async () => {
  const { api } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  let panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByText("레퍼런스", { selector: "summary span" }));
  await user.click(within(panel).getByRole("button", { name: "선택" }));
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  await user.click(screen.getByRole("button", { name: "완료" }));
  panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ referenceIds: fixtureAssets.slice(0, 6).map(asset => asset.id) }), true));
});
async function mount(targetId?: string, pendingOnly = false, groups: CharacterGroup[] = [], groupId?: string, withChrome = false, legacy?: { seriesAutoClassify?: boolean; excludedCount?: number; targetEnabled?: boolean; folders?: SeriesFolder[]; exclusions?: string[]; privacyMode?: boolean; sourceUrl?: string }) {
  const api=createCharacterFixture(), sourceTargets=await api.targets();
  const targets = legacy?.targetEnabled === undefined ? sourceTargets : sourceTargets.map(target => target.id === (targetId ?? "hina") ? { ...target, enabled: legacy.targetEnabled!, ready: legacy.targetEnabled! && target.ready } : target);
  if (pendingOnly) { api.reviewPending = vi.fn(async () => true); vi.spyOn(api, "review"); }
  const browse=vi.fn().mockResolvedValue({ items:fixtureAssets.slice(5).map(asset => ({ ...asset, sourceUrl: legacy?.sourceUrl ?? asset.sourceUrl })),nextCursor:null,totalCount:13 });
  const hubApi={folderExclusions:vi.fn().mockResolvedValue([]),seriesFolders:vi.fn().mockResolvedValue(legacy?.folders ?? []),setFolderExcluded:vi.fn().mockResolvedValue(undefined),browse,saveSeries:vi.fn(),series:vi.fn(),createManualCharacter:vi.fn(),completeReview:vi.fn().mockResolvedValue(1),setSeriesAssetExcluded:vi.fn(),excludedAssets:vi.fn().mockResolvedValue({items:[],nextCursor:null,totalCount:legacy?.excludedCount ?? 0}),
    referenceCandidates:vi.fn(async(targetId:string)=>{ const target=targets.find(item=>item.id===targetId)!; return {targetId,targetRevision:target.revision,referenceSetHash:`set-${targetId}`,confirmationMode:target.manualOnly?"initialize":"add_learned",minimumSelection:target.manualOnly?5:1,items:fixtureAssets.slice(5,7),suggestedAssetIds:fixtureAssets.slice(5,7).map(item=>item.id)}; }),
    confirmReferenceBatch:vi.fn(async()=>targets[0]),
    requestReferenceRefresh:vi.fn(async(targetId:string)=>({targetId,requestRevision:1,state:"pending" as const,eligibleCount:12})),
  } as CharacterHubApi;
  const navigate=vi.fn(),changed=vi.fn();
  const onGalleryLayoutChange=vi.fn(),onMetadataVisibleChange=vi.fn(),onPrivacyModeChange=vi.fn(),onThumbnailRowHeightChange=vi.fn();
  const gateway={listAssets:vi.fn().mockResolvedValue({items:fixtureAssets,nextCursor:null}),openLibrary:vi.fn()} as unknown as LibraryGateway;
  const browser=<SeriesBrowser folderExclusions={legacy?.exclusions ?? []} targetId={targetId} groupId={groupId} series={{classificationId:"series",heroAssetId:null,autoClassify:legacy?.seriesAutoClassify ?? true}} targets={targets} groups={groups} classifications={[...fixtureClassifications, {id:"machines",name:"기체",kind:"tag",parentId:"series",iconKey:null,colorKey:null}]} galleryLayout="masonry" onGalleryLayoutChange={onGalleryLayoutChange} privacyMode={legacy?.privacyMode ?? false} onPrivacyModeChange={onPrivacyModeChange} metadataVisible onMetadataVisibleChange={onMetadataVisibleChange} thumbnailRowHeight={180} onThumbnailRowHeightChange={onThumbnailRowHeightChange} refreshVersion={0} onNavigate={navigate} onChanged={changed} api={api} hubApi={hubApi} />;
  render(<LibraryProvider gateway={gateway}>{withChrome ? <WorkspaceChromeProvider scope="series"><div className="workspace-navigation"><aside className="workspace-index"><ChromeSettingsDock /></aside>{browser}</div></WorkspaceChromeProvider> : browser}</LibraryProvider>);
  return {api,browse,navigate,changed,hubApi,onGalleryLayoutChange,onMetadataVisibleChange,onPrivacyModeChange,onThumbnailRowHeightChange};
}

it("provides working display settings inside character folders", async () => {
  const callbacks=await mount("hina",false,[],undefined,true); const user=userEvent.setup();
  const trigger=await screen.findByRole("button",{name:"보기 설정"});
  expect(trigger).toBeEnabled();
  await user.click(trigger);
  const panel=screen.getByRole("dialog",{name:"보기 설정"});
  await user.selectOptions(within(panel).getByLabelText("배치"),"justified");
  await user.click(within(panel).getByRole("checkbox",{name:"정보 숨기기"}));
  await user.click(within(panel).getByRole("checkbox",{name:"비공개 모드"}));
  expect(callbacks.onGalleryLayoutChange).toHaveBeenCalledWith("justified");
  expect(callbacks.onMetadataVisibleChange).toHaveBeenCalledWith(false);
  expect(callbacks.onPrivacyModeChange).toHaveBeenCalledWith(true);
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
  expect(within(filters).getByRole("radio", { name: "미분류" })).toBeInTheDocument();
  expect(within(filters).getByRole("radio", { name: "전체 이미지" })).toBeInTheDocument();
  expect(within(filters).queryByRole("radio", { name: "추가 확인" })).not.toBeInTheDocument();
  expect(within(filters).queryByRole("radio", { name: "자동 분류 제외" })).not.toBeInTheDocument();
  await userEvent.setup().click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const actions = screen.getByRole("region", { name: "선택 이미지 캐릭터 지정" });
  expect(within(actions).queryByRole("button", { name: "확인 완료" })).not.toBeInTheDocument();
  expect(within(actions).queryByRole("button", { name: "자동 분류에서 제외" })).not.toBeInTheDocument();
});

it("shows legacy series recovery only when legacy state exists", async () => {
  await mount(undefined, false, [], undefined, false, { seriesAutoClassify: false, excludedCount: 2 });
  expect(await screen.findByRole("button", { name: "자동 분류 다시 켜기" })).toBeInTheDocument();
  const filters = screen.getByRole("radiogroup", { name: "시리즈 이미지 필터" });
  expect(within(filters).getByRole("radio", { name: "자동 분류 제외" })).toBeInTheDocument();
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
  expect(screen.queryByRole("button", { name: "자동 분류 다시 켜기" })).not.toBeInTheDocument();
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
  await screen.findByRole("heading",{name:"그룹 · 선도부"});
  expect(screen.getByRole("button",{name:"히나 열기"})).toBeVisible();
  expect(screen.getByRole("button",{name:"키사키 열기"})).toBeVisible();
  await waitFor(()=>expect(mounted.browse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",targetId:null,groupId:"duo"})));
  expect(screen.getByRole("heading",{name:/선도부 이미지/})).toBeVisible();
});

it("selects in the existing gallery and preserves the editor draft",async()=>{
  const {api,browse,navigate}=await mount(); const saveSettings=vi.spyOn(api,"saveSettings"); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"히나 편집"}));
  let panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.type(within(panel).getByLabelText("설명"),"기준 설명");
  await user.click(within(panel).getByText("레퍼런스"));
  await user.click(within(panel).getByRole("button",{name:"선택"}));
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
  await user.click(within(panel).getByRole("button",{name:"선택"}));
  await screen.findByRole("option",{name:"이미지 5.webp"});
  expect(candidateCalls()).toBe(1);
});

it("keeps the series header focused on creation and moves cover setup into a menu",async()=>{
  await mount(undefined,false,[],undefined,true);
  const user=userEvent.setup();
  const toolbar=screen.getByRole("toolbar",{name:"시리즈 도구"});
  const create=within(toolbar).getByRole("button",{name:"캐릭터 만들기"});
  expect(create).toHaveTextContent("캐릭터 만들기");
  expect(within(toolbar).queryByRole("button",{name:"새로고침"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:"히어로 이미지 선택"})).not.toBeInTheDocument();
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

it("keeps character selection in place without a persistent refresh button",async()=>{
  await mount("hina");
  const user=userEvent.setup();
  const toolbar=screen.getByRole("toolbar",{name:"시리즈 도구"});
  expect(within(toolbar).getByRole("button",{name:"레퍼런스 추가"})).toBeVisible();
  expect(within(toolbar).getByRole("button",{name:"캐릭터 더보기"})).toBeVisible();
  expect(within(toolbar).queryByRole("button",{name:"새로고침"})).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await user.click(within(toolbar).getByRole("button",{name:"캐릭터 더보기"}));
  await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.keyboard("{Escape}");
  expect(screen.getByRole("option",{name:"이미지 5.webp"})).toHaveAttribute("aria-selected","true");
  expect(within(toolbar).getByRole("button",{name:"이 캐릭터에서 제외"})).toBeVisible();
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
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  const actions=screen.getByRole("region",{name:"선택 이미지 캐릭터 지정"});
  await user.click(within(actions).getByRole("button",{name:"새 캐릭터"}));
  const dialog=screen.getByRole("dialog",{name:"새 캐릭터"});
  expect(within(dialog).getByText(/수동 관리로 시작/)).toBeVisible();
  await user.type(within(dialog).getByRole("textbox",{name:"캐릭터 이름"}),"단역");
  await user.click(within(dialog).getByRole("button",{name:"캐릭터 만들기"}));
  await waitFor(()=>expect(first.hubApi.createManualCharacter).toHaveBeenCalledWith({seriesId:"series",displayName:"단역",assetIds:["image-5"]}));
  expect(first.navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterId:"manual"});
});

it("keeps character selection in the header without review status",async()=>{
  const {api}=await mount("hina"); const user=userEvent.setup();
  const decide=vi.spyOn(api,"decide");
  expect(screen.queryByRole("button",{name:/검토/})).not.toBeInTheDocument();
  expect(screen.queryByText("0장 선택")).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  expect(screen.getAllByText("1장 선택")).toHaveLength(1);
  expect(within(screen.getByRole("toolbar",{name:"시리즈 도구"})).getByText("1장 선택")).toBeInTheDocument();
  expect(document.querySelector(".series-gallery .series-selection")).toBeNull();
  await user.click(screen.getByRole("button",{name:"이 캐릭터에서 제외"}));
  await waitFor(()=>expect(decide).toHaveBeenCalledWith(expect.objectContaining({targetId:"hina",assetIds:["image-5"],decision:"rejected"})));
  expect(screen.queryByText("1장 선택")).not.toBeInTheDocument();
});

it("assigns multiple checked characters in one batch and clears only on success", async () => {
  const { api } = await mount();
  const user = userEvent.setup();
  const batch = vi.spyOn(api, "decideBatch").mockRejectedValueOnce(new Error("저장 실패"));
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const panel = screen.getByRole("region", { name: "선택 이미지 캐릭터 지정" });
  await user.click(within(panel).getByText("캐릭터 지정…"));
  await user.click(within(panel).getByRole("checkbox", { name: "히나" }));
  await user.click(within(panel).getByRole("checkbox", { name: "키사키" }));
  await user.click(within(panel).getByRole("button", { name: "지정 · 2명" }));
  await screen.findByText("저장 실패");
  expect(within(panel).getByRole("checkbox", { name: "히나" })).toBeChecked();
  expect(within(panel).getByText("1장 선택")).toBeInTheDocument();
  batch.mockResolvedValueOnce(2);
  await user.click(within(panel).getByRole("button", { name: "지정 · 2명" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "선택 이미지 캐릭터 지정" })).not.toBeInTheDocument());
  expect(batch).toHaveBeenLastCalledWith([
    expect.objectContaining({ targetId: "hina", assetIds: ["image-5"], decision: "accepted" }),
    expect.objectContaining({ targetId: "kisaki", assetIds: ["image-5"], decision: "accepted" }),
  ]);
});

it("keeps character assignment collapsed and filters the list on demand", async () => {
  await mount(); const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const panel = screen.getByRole("region", { name: "선택 이미지 캐릭터 지정" });
  const assignment = within(panel).getByText("캐릭터 지정…").closest("details");
  expect(assignment).not.toHaveAttribute("open");
  await user.click(within(panel).getByText("캐릭터 지정…"));
  expect(assignment).toHaveAttribute("open");
  await user.type(within(panel).getByRole("textbox", { name: "캐릭터 찾기" }), "키사");
  expect(within(panel).getByRole("checkbox", { name: "키사키" })).toBeInTheDocument();
  expect(within(panel).queryByRole("checkbox", { name: "히나" })).not.toBeInTheDocument();
});

it("groups character references behind a reference section", async () => {
  await mount("hina"); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  const references = within(panel).getByText("레퍼런스").closest("details");
  expect(references).not.toHaveAttribute("open");
  expect(within(panel).getByLabelText("캐릭터 이름")).toBeInTheDocument();
  await user.click(within(panel).getByText("레퍼런스"));
  expect(references).toHaveAttribute("open");
});

it("hides routine per-character participation controls", async () => {
  await mount("hina"); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(within(panel).queryByRole("checkbox", { name: "자동 분석에 사용" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "자동 분류 다시 사용" })).not.toBeInTheDocument();
});

it("offers recovery when a legacy character is disabled", async () => {
  await mount("hina", false, [], undefined, false, { targetEnabled: false }); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "자동 분류 다시 사용" }));
  expect(within(panel).queryByRole("button", { name: "자동 분류 다시 사용" })).not.toBeInTheDocument();
});


it("opens manual reference selection from the character folder and saves only the chosen images", async () => {
  const { api, browse, hubApi } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "레퍼런스 추가" }));
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
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  const refresh = within(panel).getByRole("button", { name: "과거 미분류 이미지 갱신" });
  await user.click(refresh);
  expect(hubApi.requestReferenceRefresh).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await user.click(refresh);
  await waitFor(() => expect(hubApi.requestReferenceRefresh).toHaveBeenCalledWith("hina", 1));
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("미분류 이미지 전체"));
  expect(await screen.findByText("미분류 이미지 12개 갱신을 예약했습니다. 작업 센터에서 진행 상황을 확인할 수 있습니다.")).toBeVisible();
});

it("limits an existing character portrait picker to its own folder", async () => {
  const { browse } = await mount("hina");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "대표 이미지 선택" }));
  await waitFor(() => expect(browse).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", referenceTargetId: "hina", all: true })));
  expect(screen.getByRole("heading", { name: /히나 캐릭터 폴더/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "미분류만 보기" })).not.toBeInTheDocument();
});

it("allows reference selection from the series after opening the character folder", async () => {
  const {browse}=await mount("hina"); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 더보기"}));
  const panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await user.click(await screen.findByRole("button",{name:"시리즈에서 이미지 찾기"}));
  await waitFor(()=>expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({targetId:null,referenceTargetId:"hina"})));
  const callsBeforeReturn=browse.mock.calls.length;
  await user.click(screen.getByRole("button",{name:"캐릭터 폴더로 돌아가기"}));
  await screen.findByRole("heading",{name:/히나 캐릭터 폴더/});
  expect(browse).toHaveBeenCalledTimes(callsBeforeReturn);
});

it("shows only character states that need attention on overview cards", async () => {
  await mount();
  await screen.findByRole("button", { name: "히나 열기" });
  expect(screen.queryByLabelText("기준 이미지 준비 완료")).not.toBeInTheDocument();
});

it("places ordinary folders beside characters with navigation and a persisted exclusion action", async () => {
  const { navigate, hubApi, changed } = await mount(undefined, false, [], undefined, false, {
    folders: [{ classificationId: "machines", thumbnailAssetId: "asset-5" }], privacyMode: true,
  });
  const card = await screen.findByRole("button", { name: "기체 폴더 열기" });
  expect(card.closest(".series-characters")).toContainElement(screen.getByRole("button", { name: "히나 열기" }));
  expect(card.querySelector("img")).toHaveClass("character-private");
  const user = userEvent.setup();
  await user.click(card);
  expect(navigate).toHaveBeenCalledWith({ kind: "classification", classificationId: "machines" });
  await user.click(screen.getByRole("button", { name: "기체 폴더 더보기" }));
  await user.click(screen.getByRole("menuitem", { name: "캐릭터 분류에서 제외" }));
  await waitFor(() => expect(hubApi.setFolderExcluded).toHaveBeenCalledWith("machines", true));
  await waitFor(() => expect(changed).toHaveBeenCalled());
});

it("restores folder inclusion and leaves failed saves recoverable", async () => {
  const { hubApi, changed } = await mount(undefined, false, [], undefined, false, {
    folders: [{ classificationId: "machines", thumbnailAssetId: null }], exclusions: ["machines"],
  });
  const card = await screen.findByRole("button", { name: "기체 폴더 열기" });
  expect(within(card).getByText("캐릭터 분류 제외")).toBeVisible();
  vi.mocked(hubApi.setFolderExcluded).mockRejectedValueOnce(new Error("저장 실패"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "기체 폴더 더보기" }));
  await user.click(screen.getByRole("menuitem", { name: "캐릭터 분류에 다시 포함" }));
  await screen.findByRole("alert");
  expect(changed).not.toHaveBeenCalled();
  expect(within(card).getByText("캐릭터 분류 제외")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "기체 폴더 더보기" }));
  await user.click(screen.getByRole("menuitem", { name: "캐릭터 분류에 다시 포함" }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(hubApi.setFolderExcluded).toHaveBeenLastCalledWith("machines", false);
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
