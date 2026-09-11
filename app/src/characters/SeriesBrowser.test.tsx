import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { type CharacterGroup, type CharacterHubApi } from "./hubApi";
import { ChromeSettingsDock, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";

beforeEach(() => { Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable:true,get:()=>850 },clientHeight:{configurable:true,get:()=>650} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function mount(targetId?: string, pendingOnly = false, groups: CharacterGroup[] = [], groupId?: string, withChrome = false) {
  const api=createCharacterFixture(), targets=await api.targets();
  if (pendingOnly) { api.reviewPending = vi.fn(async () => true); vi.spyOn(api, "review"); }
  const browse=vi.fn().mockResolvedValue({ items:fixtureAssets.slice(5),nextCursor:null,totalCount:13 });
  const hubApi={browse,saveSeries:vi.fn(),series:vi.fn(),createManualCharacter:vi.fn(),completeReview:vi.fn().mockResolvedValue(1),setSeriesAssetExcluded:vi.fn(),excludedAssets:vi.fn().mockResolvedValue({items:[],nextCursor:null,totalCount:0})} as CharacterHubApi;
  const navigate=vi.fn(),changed=vi.fn();
  const onGalleryLayoutChange=vi.fn(),onMetadataVisibleChange=vi.fn(),onPrivacyModeChange=vi.fn(),onThumbnailRowHeightChange=vi.fn();
  const gateway={listAssets:vi.fn().mockResolvedValue({items:fixtureAssets,nextCursor:null}),openLibrary:vi.fn()} as unknown as LibraryGateway;
  const browser=<SeriesBrowser targetId={targetId} groupId={groupId} series={{classificationId:"series",heroAssetId:null,autoClassify:true}} targets={targets} groups={groups} classifications={fixtureClassifications} galleryLayout="masonry" onGalleryLayoutChange={onGalleryLayoutChange} privacyMode={false} onPrivacyModeChange={onPrivacyModeChange} metadataVisible onMetadataVisibleChange={onMetadataVisibleChange} thumbnailRowHeight={180} onThumbnailRowHeightChange={onThumbnailRowHeightChange} refreshVersion={0} onNavigate={navigate} onChanged={changed} api={api} hubApi={hubApi} />;
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
it("keeps the four series gallery filters exclusive and defaults to unclassified", async () => {
  const { browse, hubApi } = await mount();
  const user = userEvent.setup();
  const filters = await screen.findByRole("radiogroup", { name: "시리즈 이미지 필터" });

  expect(within(filters).getByRole("radio", { name: "미분류" })).toBeChecked();
  await waitFor(() => expect(browse).toHaveBeenCalledWith(expect.objectContaining({
    targetId: null, all: false, seriesFilter: "unclassified",
  })));

  await user.click(within(filters).getByRole("radio", { name: "추가 확인" }));
  await waitFor(() => expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({
    targetId: null, all: false, seriesFilter: "needs_review",
  })));
  expect(within(filters).getByRole("radio", { name: "추가 확인" })).toBeChecked();
  expect(within(filters).getByRole("radio", { name: "미분류" })).not.toBeChecked();

  await user.click(within(filters).getByRole("radio", { name: "전체 이미지" }));
  await waitFor(() => expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({
    targetId: null, all: true, seriesFilter: "all",
  })));

  await user.click(within(filters).getByRole("radio", { name: "자동 분류 제외" }));
  await waitFor(() => expect(hubApi.excludedAssets).toHaveBeenLastCalledWith("series", null, 100));
  expect(within(filters).getByRole("radio", { name: "자동 분류 제외" })).toBeChecked();
  expect(within(filters).getAllByRole("radio").filter(control => (control as HTMLInputElement).checked)).toHaveLength(1);
});
it("marks selected needs-review images complete without changing character assignment", async () => {
  const { hubApi } = await mount(); const user = userEvent.setup();
  await user.click((await screen.findByRole("radiogroup", { name: "시리즈 이미지 필터" })).querySelector('input[value="needs_review"]')!);
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const actions = screen.getByRole("region", { name: "선택 이미지 캐릭터 지정" });
  await user.click(within(actions).getByRole("button", { name: "확인 완료" }));
  await waitFor(() => expect(hubApi.completeReview).toHaveBeenCalledWith({ seriesId: "series", assetIds: ["image-5"] }));
  expect(screen.queryByText("1장 선택")).not.toBeInTheDocument();
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
  await user.click(within(panel).getByText("자동 분류"));
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
  await user.click(await screen.findByRole("button",{name:"캐릭터 등록"}));
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
  await user.click(await screen.findByRole("button",{name:"캐릭터 등록"}));
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

it("creates an underfilled character or explicitly ends automatic classification",async()=>{
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

  cleanup();
  const second=await mount();
  await userEvent.setup().click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await userEvent.setup().click(screen.getByRole("button",{name:"자동 분류에서 제외"}));
  await waitFor(()=>expect(second.hubApi.setSeriesAssetExcluded).toHaveBeenCalledWith({seriesId:"series",assetIds:["image-5"],excluded:true}));
  await userEvent.setup().click(screen.getByRole("radio",{name:"자동 분류 제외"}));
  await waitFor(()=>expect(second.hubApi.excludedAssets).toHaveBeenCalledWith("series",null,100));
});

it("keeps character selection in the header and shows pending review",async()=>{
  const {api}=await mount("hina"); const user=userEvent.setup();
  const decide=vi.spyOn(api,"decide");
  await screen.findByRole("button",{name:"검토 · 검토 대기 있음"});
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

it("groups advanced character settings behind an automation section", async () => {
  await mount("hina"); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  const automation = within(panel).getByText("자동 분류").closest("details");
  expect(automation).not.toHaveAttribute("open");
  expect(within(panel).getByLabelText("캐릭터 이름")).toBeInTheDocument();
  await user.click(within(panel).getByText("자동 분류"));
  expect(automation).toHaveAttribute("open");
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

it("uses the lightweight pending lookup without loading review evidence for the badge", async () => {
  const { api } = await mount("hina", true);
  await screen.findByRole("button", { name: "검토 · 검토 대기 있음" });
  expect(api.reviewPending).toHaveBeenCalledWith("series", "hina");
  expect(api.review).not.toHaveBeenCalled();
});

it("opens character review inside the shared series workspace", async () => {
  await mount("hina", true); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "검토 · 검토 대기 있음" }));
  expect(screen.queryByRole("dialog", { name: /검토/ })).not.toBeInTheDocument();
  expect(screen.getByRole("toolbar", { name: "시리즈 도구" })).toHaveTextContent("히나");
  expect(screen.getByRole("button", { name: "이미지로 돌아가기" })).toBeInTheDocument();
  expect(await screen.findByRole("complementary", { name: "선택 이미지 판단" })).toBeInTheDocument();
});

it("opens scoped series automation settings instead of toggling immediately", async () => {
  const { hubApi } = await mount("hina"); const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "블루 아카이브 자동 분류 설정 · 켜짐" });
  await user.click(trigger);
  expect(hubApi.saveSeries).not.toHaveBeenCalled();
  const panel = screen.getByRole("dialog", { name: "블루 아카이브 자동 분류" });
  await user.click(within(panel).getByRole("checkbox", { name: "블루 아카이브의 새 이미지를 자동 분류" }));
  await waitFor(() => expect(hubApi.saveSeries).toHaveBeenCalledWith(expect.objectContaining({ autoClassify: false })));
});

it("shows only character states that need attention on overview cards", async () => {
  await mount();
  await screen.findByRole("button", { name: "히나 열기" });
  expect(screen.queryByLabelText("기준 이미지 준비 완료")).not.toBeInTheDocument();
});
